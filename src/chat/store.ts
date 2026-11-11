import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { isAiInvocation } from "../ai/intent";
import { currentCaseQuote } from "../approval/baseline";
import { changeOrderView } from "../approval/view";
import { revisions } from "../db/schema";
import { quoteFingerprint } from "../quotes/fingerprint";
import { readCaseMoneyContext } from "../ai/money-context";
import type { Db } from "../db/client";
import { withRevisedLine, withV1Lines } from "../opening/carry";
import { documentHash, openingDocument } from "../opening/document";
import { readOpening } from "../opening/read";
import { openingQuotes } from "../opening/schema";
import { QUOTE_MESSAGE_MAX } from "../opening/types";
import { sampleProject } from "../demo/sample-projects";
import { sentFromChat } from "../projects/settings";
import { insertProject, isRealStudio } from "../projects/store";
import { insertBaseline } from "../pricing/bridge";
import { changeOrders } from "../pricing/schema";
import { isCaseKey } from "./cases";
import { chatCases, chatMessages } from "./schema";
import type { AppendMessageInput, BeginAiResult, CaseKey, CaseMessage, ChatStore, SendQuoteInput, SentVersion, StoredCase } from "./types";

const RUN_TIMEOUT_MS = 180_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof chatCases.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

export class ChatStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChatStoreError";
  }
}

function validateScope(sessionId: string, projectKey: CaseKey): void {
  if (!UUID.test(sessionId) || !isCaseKey(projectKey)) {
    throw new ChatStoreError("INVALID_INPUT", "A valid studio and project are required.");
  }
}

function validateMessageId(id: string): void {
  if (!UUID.test(id)) throw new ChatStoreError("INVALID_INPUT", "Message id must be a UUID.");
}

/**
 * Locks the project. A real studio has only the projects its designers created;
 * a demo studio, or a session from before studios, gets a sample project the
 * first time it opens one.
 */
async function lockCase(tx: Transaction, sessionId: string, projectKey: CaseKey): Promise<CaseRow> {
  const lock = () => tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, projectKey))).for("update");
  const [found] = await lock();
  if (found) return found;
  const sample = sampleProject(projectKey);
  if (!sample || await isRealStudio(tx, sessionId)) throw new ChatStoreError("PROJECT_NOT_FOUND", "This studio has no such project.");
  await insertProject(tx, sessionId, projectKey, sample);
  const [created] = await lock();
  return created;
}

async function readMessage(tx: Transaction, caseId: string, messageId: string): Promise<MessageRow> {
  const [message] = await tx.select().from(chatMessages).where(and(eq(chatMessages.caseId, caseId), eq(chatMessages.id, messageId)));
  if (!message || message.actor === "assistant") {
    throw new ChatStoreError("MESSAGE_NOT_FOUND", "The human message does not belong to this case.");
  }
  return message;
}

function publicMessage(message: MessageRow): CaseMessage {
  return {
    id: message.id,
    actor: message.actor,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    replyToMessageId: message.replyToMessageId,
    aiState: message.aiState,
    error: message.error,
    model: message.model,
    moneyAnswer: message.moneyAnswer,
    quoteAnswer: message.quoteAnswer,
    aboutItemId: message.aboutItemId,
  };
}

async function sentVersions(tx: Transaction, row: CaseRow): Promise<SentVersion[]> {
  const orders = await tx.select({ document: changeOrders.document, status: revisions.status, messageId: changeOrders.messageId }).from(changeOrders)
    .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).where(eq(changeOrders.caseId, row.id)).orderBy(asc(revisions.number));
  return orders.map(({ document, status, messageId }) => ({
    id: document.id, version: document.version, basedOnVersion: document.basedOnVersion, title: document.title, messageId, issuedAt: document.issuedAt,
    changeCount: document.changes.length, totalCents: document.totals.totalCents, deltaTotalCents: document.deltaTotalCents, status: changeOrderView(document, status).status,
    fromCurrentDraft: !!row.draft && document.sourceDraftId === row.draft.id && document.sourceDraftRevision === row.draft.revision,
    ...(document.source ? { source: document.source } : {}),
  }));
}

async function snapshot(tx: Transaction, row: CaseRow): Promise<StoredCase> {
  const messages = await tx.select().from(chatMessages).where(eq(chatMessages.caseId, row.id)).orderBy(asc(chatMessages.sequence));
  return { id: row.id, projectKey: row.projectKey, messages: messages.map(publicMessage), draft: row.draft, activeMessageId: row.activeMessageId, activeRunStage: row.activeMessageId ? row.activeRunStage : null, quote: (await currentCaseQuote(tx, row.id)) ?? undefined, opening: (await readOpening(tx, row)).opening, versions: await sentVersions(tx, row) };
}

async function expireRun(tx: Transaction, row: CaseRow): Promise<CaseRow> {
  if (!row.activeRunStartedAt || Date.now() - row.activeRunStartedAt.getTime() < RUN_TIMEOUT_MS) return row;
  await tx.update(chatMessages).set({ aiState: "failed", error: "AI reply timed out. Retry this message." })
    .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, row.activeMessageId!), eq(chatMessages.lastRunId, row.activeRunId!)));
  const [updated] = await tx.update(chatCases).set({ activeMessageId: null, activeRunId: null, activeRunStartedAt: null, activeRunStage: null, updatedAt: new Date() })
    .where(eq(chatCases.id, row.id)).returning();
  return updated;
}

/** All writes lock one session/case row; no model or network call holds the lock. */
export function createChatStore(db: Db): ChatStore {
  async function withinCase<T>(sessionId: string, projectKey: CaseKey, work: (tx: Transaction, row: CaseRow) => Promise<T>): Promise<T> {
    validateScope(sessionId, projectKey);
    return db.transaction(async (tx) => work(tx, await expireRun(tx, await lockCase(tx, sessionId, projectKey))));
  }

  return {
    readMoneyContext(sessionId, projectKey) {
      validateScope(sessionId, projectKey);
      return readCaseMoneyContext(db, sessionId, projectKey);
    },
    getCase(sessionId, projectKey) {
      return withinCase(sessionId, projectKey, snapshot);
    },

    async reportAiStage(sessionId, projectKey, runId, stage) {
      validateScope(sessionId, projectKey);
      // Only the run still active on the case moves its stage; a finished or replaced run is ignored.
      await db.update(chatCases).set({ activeRunStage: stage })
        .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, projectKey), eq(chatCases.activeRunId, runId)));
    },

    appendMessage(sessionId, projectKey, input: AppendMessageInput) {
      validateMessageId(input.id);
      if (!["client", "designer"].includes(input.actor) || !input.text.trim() || input.text.length > 8_000) {
        throw new ChatStoreError("INVALID_INPUT", "Send a non-empty client or designer message of at most 8,000 characters.");
      }
      const aboutItemId = input.aboutItemId ?? null;
      return withinCase(sessionId, projectKey, async (tx, row) => {
        const [existing] = await tx.select().from(chatMessages).where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, input.id)));
        if (existing) {
          if (existing.actor !== input.actor || existing.text !== input.text || existing.aboutItemId !== aboutItemId) {
            throw new ChatStoreError("IDEMPOTENCY_CONFLICT", "This message id has already been used for different content.");
          }
          return snapshot(tx, row);
        }
        if (row.activeRunId) throw new ChatStoreError("CASE_BUSY", "Wait for the current AI reply before sending another message.");
        if (aboutItemId) {
          const { opening, document } = await readOpening(tx, row);
          if (!opening.sentAt || !document.lines.some((line) => line.itemId === aboutItemId)) {
            throw new ChatStoreError("INVALID_INPUT", "A question can only be about a line of the quote V1 that was sent.");
          }
        }
        await tx.insert(chatMessages).values({ caseId: row.id, id: input.id, actor: input.actor, text: input.text, aboutItemId });
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
        return snapshot(tx, row);
      });
    },

    async sendQuote(sessionId, projectKey, input: SendQuoteInput) {
      validateMessageId(input.id);
      const text = input.text.trim();
      if (!text || text.length > QUOTE_MESSAGE_MAX || !input.sentBy.trim()) {
        throw new ChatStoreError("INVALID_INPUT", `Add a message of at most ${QUOTE_MESSAGE_MAX.toLocaleString("en-US")} characters to send with the quote.`);
      }
      return withinCase(sessionId, projectKey, async (tx, row) => {
        if (!sentFromChat(row)) throw new ChatStoreError("NOT_AVAILABLE", "This project starts from a quote the client already approved.");
        // A retry, a double click or a second window finds V1 already sent and changes nothing.
        const [sent] = await tx.select({ caseId: openingQuotes.caseId }).from(openingQuotes).where(eq(openingQuotes.caseId, row.id));
        if (sent) return snapshot(tx, row);
        const [existing] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, input.id)));
        if (existing) throw new ChatStoreError("IDEMPOTENCY_CONFLICT", "This message id has already been used for different content.");
        if (row.activeRunId) throw new ChatStoreError("CASE_BUSY", "Wait for the current AI reply before sending the quote.");
        const document = openingDocument(row);
        await tx.insert(chatMessages).values({ caseId: row.id, id: input.id, actor: "designer", text });
        await tx.insert(openingQuotes).values({ caseId: row.id, messageId: input.id, document, contentHash: documentHash(document), sentBy: input.sentBy.trim() });
        await insertBaseline(tx, row.id, document);
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
        return snapshot(tx, row);
      });
    },

    getQuote(sessionId, projectKey) {
      return withinCase(sessionId, projectKey, async (tx, row) => {
        const { document, opening, approval, lines } = await readOpening(tx, row);
        return { projectKey, document, opening, approval, lines };
      });
    },

    beginAi(sessionId, projectKey, messageId): Promise<BeginAiResult> {
      validateMessageId(messageId);
      return withinCase(sessionId, projectKey, async (tx, row) => {
        const message = await readMessage(tx, row.id, messageId);
        if (!isAiInvocation(message.text)) {
          throw new ChatStoreError("INVALID_AI_TRIGGER", "Start the message with @Setti to request a reply.");
        }
        if (message.aiState === "completed") return { status: "completed", state: await snapshot(tx, row) };
        if (row.activeRunId) {
          if (row.activeMessageId !== messageId) {
            await tx.update(chatMessages).set({ aiState: "failed", error: "Another AI reply is in progress. Retry this message when it finishes." })
              .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
          }
          return { status: "busy", state: await snapshot(tx, row) };
        }
        const [newerHuman] = await tx.select({ id: chatMessages.id }).from(chatMessages)
          .where(and(eq(chatMessages.caseId, row.id), gt(chatMessages.sequence, message.sequence), ne(chatMessages.actor, "assistant"))).limit(1);
        if (newerHuman || message.sequence < row.latestCompletedSequence) {
          throw new ChatStoreError("STALE_MESSAGE", "Newer messages already exist. Start a new @Setti message so the latest direction is included.");
        }
        const runId = randomUUID();
        await tx.update(chatMessages).set({ aiState: "running", error: null, model: null, lastRunId: runId })
          .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
        const [updated] = await tx.update(chatCases).set({ activeMessageId: messageId, activeRunId: runId, activeRunStartedAt: new Date(), activeRunStage: "reading", updatedAt: new Date() })
          .where(eq(chatCases.id, row.id)).returning();
        return { status: "started", runId, state: await snapshot(tx, updated) };
      });
    },

    async completeAi(sessionId, projectKey, messageId, runId, result) {
      validateMessageId(messageId);
      if (!result.text.trim() || !result.model.trim() || (result.draft && result.draft.projectKey !== projectKey)) {
        throw new ChatStoreError("INVALID_INPUT", "The AI result must contain text and a model for this case.");
      }
      const outcome = await withinCase(sessionId, projectKey, async (tx, row) => {
        const message = await readMessage(tx, row.id, messageId);
        if (message.aiState === "completed" && message.lastRunId === runId) return { state: await snapshot(tx, row), stale: false };
        if (row.activeRunId !== runId || row.activeMessageId !== messageId || message.aiState !== "running" || message.lastRunId !== runId) {
          return { state: await snapshot(tx, row), stale: true };
        }
        if (result.draft) {
          const quote = await currentCaseQuote(tx, row.id);
          if (!quote || result.draft.basedOnQuoteId !== quote.id || result.draft.basedOnVersion !== quote.version || result.draft.basedOnQuoteFingerprint !== quoteFingerprint(quote)) {
            throw new ChatStoreError("STALE_BASELINE", "The approved quote changed. Start a new @Setti request against the current approved version.");
          }
        }
        if (result.moneyAnswer) {
          const quote = await currentCaseQuote(tx, row.id);
          if (!quote || result.moneyAnswer.quoteId !== quote.id || result.moneyAnswer.version !== quote.version) {
            throw new ChatStoreError("STALE_BASELINE", "The approved quote changed while the recorded money answer was prepared. Ask again against the latest version.");
          }
          if ("draft" in result) throw new ChatStoreError("INVALID_INPUT", "A recorded money answer cannot modify a draft.");
        }
        if (result.quoteAnswer) {
          const quote = await currentCaseQuote(tx, row.id);
          if (!quote || result.quoteAnswer.quoteId !== quote.id || result.quoteAnswer.version !== quote.version) {
            throw new ChatStoreError("STALE_BASELINE", "The approved quote changed while the lookup ran. Ask again against the latest version.");
          }
          if ("draft" in result) throw new ChatStoreError("INVALID_INPUT", "A quote lookup cannot modify a draft.");
        }
        let draft = result.draft ?? null;
        if (draft && sentFromChat(row)) {
          // An AI draft keeps the designer's own revisions of declined V1 lines and carries every undecided V1 line.
          const read = await readOpening(tx, row);
          for (const change of row.draft?.changes ?? []) {
            if (change.fromV1?.kind === "revised" && read.lines[change.fromV1.itemId]?.state === "declined") draft = withRevisedLine(draft, change.fromV1.line, change.fromV1.reason);
          }
          draft = withV1Lines(draft, read);
        }
        await tx.insert(chatMessages).values({ caseId: row.id, id: randomUUID(), actor: "assistant", text: result.text, replyToMessageId: messageId, aiState: "completed", model: result.model, moneyAnswer: result.moneyAnswer ?? null, quoteAnswer: result.quoteAnswer ?? null });
        await tx.update(chatMessages).set({ aiState: "completed", error: null, model: result.model })
          .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
        const [updated] = await tx.update(chatCases).set({
          ...("draft" in result ? { draft } : {}),
          activeMessageId: null, activeRunId: null, activeRunStartedAt: null, activeRunStage: null,
          latestCompletedSequence: message.sequence, updatedAt: new Date(),
        }).where(eq(chatCases.id, row.id)).returning();
        return { state: await snapshot(tx, updated), stale: false };
      });
      if (outcome.stale) throw new ChatStoreError("STALE_AI_RUN", "This AI run is no longer current; its result was not saved.");
      return outcome.state;
    },

    async failAi(sessionId, projectKey, messageId, runId, error) {
      validateMessageId(messageId);
      const outcome = await withinCase(sessionId, projectKey, async (tx, row) => {
        const message = await readMessage(tx, row.id, messageId);
        if (message.aiState === "failed" && message.lastRunId === runId && row.activeRunId !== runId) {
          return { state: await snapshot(tx, row), stale: false };
        }
        if (row.activeRunId !== runId || row.activeMessageId !== messageId || message.lastRunId !== runId) {
          return { state: await snapshot(tx, row), stale: true };
        }
        await tx.update(chatMessages).set({ aiState: "failed", error: error.trim().slice(0, 2_000) || "AI reply failed. Retry this message." })
          .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
        const [updated] = await tx.update(chatCases).set({ activeMessageId: null, activeRunId: null, activeRunStartedAt: null, activeRunStage: null, updatedAt: new Date() })
          .where(eq(chatCases.id, row.id)).returning();
        return { state: await snapshot(tx, updated), stale: false };
      });
      if (outcome.stale) throw new ChatStoreError("STALE_AI_RUN", "This AI run is no longer current; the current state was not changed.");
      return outcome.state;
    },
  };
}
