import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { isAiInvocation } from "../ai/intent";
import { currentCaseQuote } from "../approval/baseline";
import { quoteFingerprint } from "../quotes/fingerprint";
import { readCaseMoneyContext } from "../ai/money-context";
import type { Db } from "../db/client";
import { documentHash, openingDocument, openingSummary, withoutApproval } from "../opening/document";
import { openingQuotes } from "../opening/schema";
import { QUOTE_MESSAGE_MAX, sentFromChat, type QuoteView } from "../opening/types";
import { caseQuote } from "./cases";
import { chatCases, chatMessages } from "./schema";
import type { AppendMessageInput, BeginAiResult, CaseKey, CaseMessage, ChatStore, SendQuoteInput, StoredCase } from "./types";

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
  if (!UUID.test(sessionId) || !["willow", "maple"].includes(projectKey)) {
    throw new ChatStoreError("INVALID_INPUT", "A valid demo session and case are required.");
  }
}

function validateMessageId(id: string): void {
  if (!UUID.test(id)) throw new ChatStoreError("INVALID_INPUT", "Message id must be a UUID.");
}

async function lockCase(tx: Transaction, sessionId: string, projectKey: CaseKey): Promise<CaseRow> {
  await tx.insert(chatCases).values({ sessionId, projectKey }).onConflictDoNothing({ target: [chatCases.sessionId, chatCases.projectKey] });
  const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, projectKey))).for("update");
  return row;
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
  };
}

/** The case's V1: a draft until the designer sends it, then the frozen document as sent. */
async function readOpening(tx: Transaction, row: CaseRow): Promise<Omit<QuoteView, "projectKey">> {
  if (!sentFromChat(row.projectKey)) {
    const quote = caseQuote(row.projectKey);
    const document = withoutApproval(quote);
    return { document, approval: { approvedBy: quote.approvedBy, approvedAt: quote.approvedAt }, opening: openingSummary(document, { status: "approved", messageId: null, sentAt: null, sentBy: null, contentHash: null }) };
  }
  const [sent] = await tx.select().from(openingQuotes).where(eq(openingQuotes.caseId, row.id));
  if (!sent) {
    const document = openingDocument(row.projectKey);
    return { document, approval: null, opening: openingSummary(document, { status: "draft", messageId: null, sentAt: null, sentBy: null, contentHash: null }) };
  }
  return { document: sent.document, approval: null, opening: openingSummary(sent.document, { status: "sent", messageId: sent.messageId, sentAt: sent.sentAt.toISOString(), sentBy: sent.sentBy, contentHash: sent.contentHash }) };
}

async function snapshot(tx: Transaction, row: CaseRow): Promise<StoredCase> {
  const messages = await tx.select().from(chatMessages).where(eq(chatMessages.caseId, row.id)).orderBy(asc(chatMessages.sequence));
  return { id: row.id, projectKey: row.projectKey, messages: messages.map(publicMessage), draft: row.draft, activeMessageId: row.activeMessageId, quote: await currentCaseQuote(tx, row.id, row.projectKey), opening: (await readOpening(tx, row)).opening };
}

async function expireRun(tx: Transaction, row: CaseRow): Promise<CaseRow> {
  if (!row.activeRunStartedAt || Date.now() - row.activeRunStartedAt.getTime() < RUN_TIMEOUT_MS) return row;
  await tx.update(chatMessages).set({ aiState: "failed", error: "AI reply timed out. Retry this message." })
    .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, row.activeMessageId!), eq(chatMessages.lastRunId, row.activeRunId!)));
  const [updated] = await tx.update(chatCases).set({ activeMessageId: null, activeRunId: null, activeRunStartedAt: null, updatedAt: new Date() })
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

    appendMessage(sessionId, projectKey, input: AppendMessageInput) {
      validateMessageId(input.id);
      if (!["client", "designer"].includes(input.actor) || !input.text.trim() || input.text.length > 8_000) {
        throw new ChatStoreError("INVALID_INPUT", "Send a non-empty client or designer message of at most 8,000 characters.");
      }
      return withinCase(sessionId, projectKey, async (tx, row) => {
        const [existing] = await tx.select().from(chatMessages).where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, input.id)));
        if (existing) {
          if (existing.actor !== input.actor || existing.text !== input.text) {
            throw new ChatStoreError("IDEMPOTENCY_CONFLICT", "This message id has already been used for different content.");
          }
          return snapshot(tx, row);
        }
        if (row.activeRunId) throw new ChatStoreError("CASE_BUSY", "Wait for the current AI reply before sending another message.");
        await tx.insert(chatMessages).values({ caseId: row.id, id: input.id, actor: input.actor, text: input.text });
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
        return snapshot(tx, row);
      });
    },

    async sendQuote(sessionId, projectKey, input: SendQuoteInput) {
      validateMessageId(input.id);
      if (!sentFromChat(projectKey)) throw new ChatStoreError("NOT_AVAILABLE", "This project starts from a quote the client already approved.");
      const text = input.text.trim();
      if (!text || text.length > QUOTE_MESSAGE_MAX || !input.sentBy.trim()) {
        throw new ChatStoreError("INVALID_INPUT", `Add a message of at most ${QUOTE_MESSAGE_MAX.toLocaleString("en-US")} characters to send with the quote.`);
      }
      return withinCase(sessionId, projectKey, async (tx, row) => {
        // A retry, a double click or a second window finds V1 already sent and changes nothing.
        const [sent] = await tx.select({ caseId: openingQuotes.caseId }).from(openingQuotes).where(eq(openingQuotes.caseId, row.id));
        if (sent) return snapshot(tx, row);
        const [existing] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, input.id)));
        if (existing) throw new ChatStoreError("IDEMPOTENCY_CONFLICT", "This message id has already been used for different content.");
        if (row.activeRunId) throw new ChatStoreError("CASE_BUSY", "Wait for the current AI reply before sending the quote.");
        const document = openingDocument(projectKey);
        await tx.insert(chatMessages).values({ caseId: row.id, id: input.id, actor: "designer", text });
        await tx.insert(openingQuotes).values({ caseId: row.id, messageId: input.id, document, contentHash: documentHash(document), sentBy: input.sentBy.trim() });
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
        return snapshot(tx, row);
      });
    },

    getQuote(sessionId, projectKey) {
      return withinCase(sessionId, projectKey, async (tx, row) => ({ projectKey, ...(await readOpening(tx, row)) }));
    },

    beginAi(sessionId, projectKey, messageId): Promise<BeginAiResult> {
      validateMessageId(messageId);
      return withinCase(sessionId, projectKey, async (tx, row) => {
        const message = await readMessage(tx, row.id, messageId);
        if (!isAiInvocation(message.text)) {
          throw new ChatStoreError("INVALID_AI_TRIGGER", "Start the message with @AI or @Change Agent to request a reply.");
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
          throw new ChatStoreError("STALE_MESSAGE", "Newer messages already exist. Start a new @AI message so the latest direction is included.");
        }
        const runId = randomUUID();
        await tx.update(chatMessages).set({ aiState: "running", error: null, model: null, lastRunId: runId })
          .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
        const [updated] = await tx.update(chatCases).set({ activeMessageId: messageId, activeRunId: runId, activeRunStartedAt: new Date(), updatedAt: new Date() })
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
          const quote = await currentCaseQuote(tx, row.id, projectKey);
          if (result.draft.basedOnQuoteId !== quote.id || result.draft.basedOnVersion !== quote.version || result.draft.basedOnQuoteFingerprint !== quoteFingerprint(quote)) {
            throw new ChatStoreError("STALE_BASELINE", "The approved quote changed. Start a new @AI request against the current approved version.");
          }
        }
        if (result.moneyAnswer) {
          const quote = await currentCaseQuote(tx, row.id, projectKey);
          if (result.moneyAnswer.quoteId !== quote.id || result.moneyAnswer.version !== quote.version) {
            throw new ChatStoreError("STALE_BASELINE", "The approved quote changed while the recorded money answer was prepared. Ask again against the latest version.");
          }
          if ("draft" in result) throw new ChatStoreError("INVALID_INPUT", "A recorded money answer cannot modify a draft.");
        }
        await tx.insert(chatMessages).values({ caseId: row.id, id: randomUUID(), actor: "assistant", text: result.text, replyToMessageId: messageId, aiState: "completed", model: result.model, moneyAnswer: result.moneyAnswer ?? null });
        await tx.update(chatMessages).set({ aiState: "completed", error: null, model: result.model })
          .where(and(eq(chatMessages.caseId, row.id), eq(chatMessages.id, messageId)));
        const [updated] = await tx.update(chatCases).set({
          ...("draft" in result ? { draft: result.draft ?? null } : {}),
          activeMessageId: null, activeRunId: null, activeRunStartedAt: null,
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
        const [updated] = await tx.update(chatCases).set({ activeMessageId: null, activeRunId: null, activeRunStartedAt: null, updatedAt: new Date() })
          .where(eq(chatCases.id, row.id)).returning();
        return { state: await snapshot(tx, updated), stale: false };
      });
      if (outcome.stale) throw new ChatStoreError("STALE_AI_RUN", "This AI run is no longer current; the current state was not changed.");
      return outcome.state;
    },
  };
}
