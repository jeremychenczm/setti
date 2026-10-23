/**
 * The client's signed line decisions on a V1 sent from the chat, and the
 * designer dropping lines the client declined or left undecided. Every write
 * locks the demo case and the V1 revision, so a signature, a drop and a V2
 * issued at the same moment are decided one after another.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatCases, chatMessages } from "../chat/schema";
import type { CaseKey, ChangeDraft } from "../chat/types";
import type { Db } from "../db/client";
import { approvals, revisions } from "../db/schema";
import { quoteFingerprint } from "../quotes/fingerprint";
import { calculateQuoteTotals } from "../quotes/totals";
import { withRevisedLine, withV1Lines } from "./carry";
import { documentHash } from "./document";
import { approvedBaseline, readOpening, type OpeningRead } from "./read";
import { openingWithdrawals } from "./schema";
import { clientSignatureName, DECLINE_REASON_MAX, sentFromChat, type QuoteView, type SignOpeningInput } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof chatCases.$inferSelect;
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

export class OpeningStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OpeningStoreError";
  }
}

function view(projectKey: CaseKey, read: OpeningRead): QuoteView {
  const { document, opening, approval, lines: states } = read;
  return { projectKey, document, opening, approval, lines: states };
}

/** After V1 changes, the case's draft carries exactly the V1 lines that still come back. */
async function syncDraft(tx: Transaction, row: CaseRow, read: OpeningRead) {
  if (!row.draft) return;
  const draft = withV1Lines(row.draft, read);
  if (draft !== row.draft) await tx.update(chatCases).set({ draft }).where(eq(chatCases.id, row.id));
}

async function record(tx: Transaction, row: CaseRow, text: string) {
  await tx.insert(chatMessages).values({ caseId: row.id, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text });
  await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
}

export function createOpeningStore(db: Db) {
  async function withinSentV1<T>(sessionId: string, key: CaseKey, work: (tx: Transaction, row: CaseRow, read: OpeningRead & { revision: NonNullable<OpeningRead["revision"]> }) => Promise<T>): Promise<T> {
    if (!UUID.test(sessionId)) throw new OpeningStoreError("FORBIDDEN", "Open this quote from the browser that owns the demo project.");
    if (!sentFromChat(key)) throw new OpeningStoreError("NOT_AVAILABLE", "This project starts from a quote the client already approved.");
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
      const read = row ? await readOpening(tx, row) : null;
      if (!row || !read?.opening.sentAt || !read.revision) throw new OpeningStoreError("NOT_SENT", "Quote V1 has not been sent in this demo project yet.");
      // Lock V1 too: a V2 issued at the same moment closes it either before or after this write.
      const [revision] = await tx.select().from(revisions).where(eq(revisions.id, read.revision.id)).for("update");
      return work(tx, row, { ...read, revision: { id: revision.id, status: revision.status, contentHash: revision.contentHash! }, opening: { ...read.opening, closed: revision.status !== "sent" } });
    });
  }

  return {
    /** Records the lines the client decides now. Undecided lines stay open for a later signature. */
    async sign(sessionId: string, key: CaseKey, input: SignOpeningInput): Promise<QuoteView> {
      if (!UUID.test(input.signingId) || typeof input.contentHash !== "string" || typeof input.signature !== "string" || input.signature.length > 160
          || input.acknowledged !== true || !Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > 200) {
        throw new OpeningStoreError("INVALID_INPUT", "Choose at least one line, confirm you reviewed the quote and type your name.");
      }
      return withinSentV1(sessionId, key, async (tx, row, read) => {
        const [retry] = await tx.select({ id: approvals.id }).from(approvals).where(eq(approvals.signingId, input.signingId)).limit(1);
        if (retry) return view(key, read);
        if (input.contentHash !== read.opening.contentHash || documentHash(read.document) !== read.opening.contentHash) {
          throw new OpeningStoreError("CONTENT_CHANGED", "The quote you reviewed no longer matches the sent V1. Reload it before signing.");
        }
        if (read.opening.closed) throw new OpeningStoreError("CLOSED", "A newer version replaced quote V1, so it takes no more decisions.");
        if (row.activeRunId) throw new OpeningStoreError("CASE_BUSY", "Wait for the current AI reply before signing.");
        const clientName = clientSignatureName(read.document);
        const signature = input.signature.trim();
        if (signature !== clientName) throw new OpeningStoreError("INVALID_INPUT", `Type the client name exactly as shown: ${clientName}.`);

        const seen = new Set<string>();
        const decisions = input.decisions.map((entry) => {
          const line = read.document.lines.find((candidate) => candidate.itemId === entry?.itemId);
          if (!line || seen.has(line.itemId) || !["approved", "declined"].includes(entry.decision)) throw new OpeningStoreError("INVALID_INPUT", "Each decision must name a different line of quote V1.");
          seen.add(line.itemId);
          if (read.lines[line.itemId].state !== "pending") throw new OpeningStoreError("ALREADY_DECIDED", `${line.name} already has a decision. A declined line can only come back in a new version.`);
          const note = typeof entry.note === "string" ? entry.note.trim() : "";
          if (entry.decision === "declined" && !note) throw new OpeningStoreError("INVALID_INPUT", `Say why you are declining ${line.name}, so the designer can revise it.`);
          if (note.length > DECLINE_REASON_MAX) throw new OpeningStoreError("INVALID_INPUT", `Keep the reason for ${line.name} under ${DECLINE_REASON_MAX.toLocaleString("en-US")} characters.`);
          return { line, decision: entry.decision, note: entry.decision === "declined" ? note : null };
        });

        const decidedAt = new Date();
        for (const { line, decision, note } of decisions) {
          await tx.insert(approvals).values({
            revisionId: read.revision.id, revisionLineId: read.lineIds.get(line.itemId)!, decision, approverName: clientName,
            signature, contentHash: read.revision.contentHash, decidedAt, note, signingId: input.signingId,
          });
        }
        const approved = decisions.filter((entry) => entry.decision === "approved");
        const after = await readOpening(tx, row);
        // A draft prepared against the earlier baseline no longer describes the approved quote.
        if (approved.length && row.draft) await tx.update(chatCases).set({ draft: null }).where(eq(chatCases.id, row.id));
        else await syncDraft(tx, row, after);
        const declined = decisions.length - approved.length;
        const pending = after.opening.progress.pending;
        await record(tx, row, `${clientName} signed quote V1: approved ${lines(approved.length)} (${usd(calculateQuoteTotals(approved.map((entry) => entry.line)).totalCents)})`
          + `${declined ? ` and declined ${lines(declined)}` : ""}.${pending ? ` ${lines(pending)} still undecided.` : ""} No payment has been made.`);
        return view(key, await readOpening(tx, row));
      });
    },

    /**
     * The designer revises a declined line by hand: it enters the case's draft
     * (a new designer draft, or the current one) as an added line, filled in from
     * V1, together with every line the client has not decided on yet.
     */
    async revise(sessionId: string, key: CaseKey, input: { itemId: string }): Promise<{ draft: ChangeDraft }> {
      return withinSentV1(sessionId, key, async (tx, row, read) => {
        if (read.opening.closed) throw new OpeningStoreError("CLOSED", "A newer version replaced quote V1. Change its lines in that version instead.");
        if (row.activeRunId) throw new OpeningStoreError("CASE_BUSY", "Wait for the current AI reply before revising.");
        const line = read.document.lines.find((candidate) => candidate.itemId === input.itemId);
        if (!line) throw new OpeningStoreError("INVALID_INPUT", "This line is not part of quote V1.");
        const state = read.lines[line.itemId];
        if (state.state !== "declined") throw new OpeningStoreError("NOT_AVAILABLE", `Only a line the client declined can be revised; ${line.name} is ${state.state === "withdrawn" ? "dropped" : state.state}.`);
        const baseline = approvedBaseline(read);
        if (!baseline) throw new OpeningStoreError("NOT_AVAILABLE", "The client has not approved any line of quote V1 yet. A new version starts from the approved lines.");
        const fingerprint = quoteFingerprint(baseline);
        const current = row.draft && row.draft.basedOnQuoteId === baseline.id && row.draft.basedOnVersion === baseline.version && row.draft.basedOnQuoteFingerprint === fingerprint ? row.draft : null;
        const now = new Date().toISOString();
        const base: ChangeDraft = current ?? {
          id: randomUUID(), projectKey: key, basedOnQuoteId: baseline.id, basedOnVersion: baseline.version, basedOnQuoteFingerprint: fingerprint,
          revision: 0, status: "needs_designer_review", title: "Revised lines from quote V1",
          summary: "The designer's revision of lines the client declined in quote V1. Lines the client has not decided on come along for a decision in the same version.",
          changes: [], sourceMessageIds: [], sources: [], unresolved: [], constraints: [], deltaSubtotalCents: 0, createdAt: now, updatedAt: now, model: "designer",
        };
        const draft = withV1Lines(withRevisedLine(base, line, state.note), read);
        if (draft !== row.draft) await tx.update(chatCases).set({ draft, updatedAt: new Date() }).where(eq(chatCases.id, row.id));
        return { draft };
      });
    },

    /** The designer drops a line the client declined or never decided on. It was never agreed, so no signature is needed. */
    async drop(sessionId: string, key: CaseKey, input: { itemId: string; by: string }): Promise<QuoteView> {
      return withinSentV1(sessionId, key, async (tx, row, read) => {
        if (read.opening.closed) throw new OpeningStoreError("CLOSED", "A newer version replaced quote V1. Change its lines in that version instead.");
        const line = read.document.lines.find((candidate) => candidate.itemId === input.itemId);
        if (!line) throw new OpeningStoreError("INVALID_INPUT", "This line is not part of quote V1.");
        const state = read.lines[line.itemId];
        if (state.state === "withdrawn") return view(key, read);
        if (state.state === "approved") throw new OpeningStoreError("NOT_AVAILABLE", `The client approved ${line.name}. Changing an approved line needs a new version.`);
        await tx.insert(openingWithdrawals).values({ caseId: row.id, itemId: line.itemId, withdrawnBy: input.by });
        await syncDraft(tx, row, await readOpening(tx, row));
        await record(tx, row, state.state === "declined"
          ? `${input.by} dropped ${line.name} from quote V1. The client had declined it: "${state.note}".`
          : `${input.by} withdrew ${line.name} from quote V1 before the client decided on it.`);
        return view(key, await readOpening(tx, row));
      });
    },
  };
}
