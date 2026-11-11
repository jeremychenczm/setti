/** The Maple Ave Café preparation history, separate from the visitor's live AI discussion. */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatCases, chatMessages } from "../chat/schema";
import type { Db } from "../db/client";
import { approvals } from "../db/schema";
import { HOME_APPROVED_QUOTE, HOME_DISCUSSION, HOME_SCENARIO, HOME_SUPPLIER_NOTES } from "../demo/living-dining";
import { TRY_PROJECT } from "../demo/sample-projects";
import { insertProject } from "../projects/store";
import { TRY_PROJECT_KEY } from "./preparation";
import { documentHash, withoutApproval } from "../opening/document";
import { openingQuotes } from "../opening/schema";
import { insertBaseline } from "../pricing/bridge";
import { pricingCases } from "../pricing/schema";
import type { ApprovedQuoteReport } from "../quotes/types";
import { MaplePreparationError } from "./maple";

/** A workspace keeps the V1 it was prepared from: the café, or the earlier living-and-dining story. */
const HOME_BASELINE_IDS = [HOME_APPROVED_QUOTE.id, "demo-maple-living-dining-v1"];

async function ensureBaseline(db: Db, session: string): Promise<ApprovedQuoteReport> {
  return db.transaction(async (tx) => {
    await insertProject(tx, session, TRY_PROJECT_KEY, TRY_PROJECT);
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, "maple"))).for("update");
    const [existing] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, row.id));
    if (existing) {
      if (!existing.baselineQuote || !HOME_BASELINE_IDS.includes(existing.baselineQuote.id)) throw new MaplePreparationError("This workspace has another scenario's baseline. Its existing payments were left unchanged.", false);
      return existing.baselineQuote;
    }
    const quote = structuredClone(HOME_APPROVED_QUOTE);
    const { bridge, revisionHash, lineIds } = await insertBaseline(tx, row.id, quote, quote);
    const messageId = discussionId(session, "opening-v1");
    const document = withoutApproval(quote);
    await tx.insert(chatMessages).values({ caseId: row.id, id: messageId, actor: "designer", model: "demo-prepared-history", text: "Prepared project history: Emma has confirmed this original counter and back-bar quote V1. The design discussion below leads to the first revision.", createdAt: new Date(quote.approvedAt) });
    await tx.insert(openingQuotes).values({ caseId: row.id, messageId, document, contentHash: documentHash(document), sentBy: quote.designerName, sentAt: new Date(quote.approvedAt) });
    const signingId = randomUUID();
    for (const line of quote.lines) {
      await tx.insert(approvals).values({
        revisionId: bridge.baselineRevisionId, revisionLineId: lineIds.get(line.itemId)!, decision: "approved",
        approverName: line.approval.approvedBy, signature: line.approval.signature,
        contentHash: revisionHash, decidedAt: new Date(line.approval.approvedAt),
        signingId,
      });
    }
    // A signed opening remains 'sent' until a later version supersedes it, as for Willow.
    return quote;
  });
}

/** Only local records: make the agreed V1 and discussion available before any provider call. */
export async function ensureHomeWorkspace(db: Db, session: string): Promise<ApprovedQuoteReport> {
  const quote = await ensureBaseline(db, session);
  await appendHomeDiscussion(db, session);
  return quote;
}

/** Stable UUIDs and one transaction prevent a resumed final stage from repeating the conversation. */
function discussionId(session: string, entry: string): string {
  const hex = createHash("sha256").update(`${HOME_SCENARIO}:${session}:${entry}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function appendHomeDiscussion(db: Db, session: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, "maple"))).for("update");
    if (!row) throw new MaplePreparationError("The prepared discussion workspace is unavailable.");
    const messages = [...HOME_DISCUSSION.map((message) => ({ ...message, model: "demo-scenario-discussion" })),
      { actor: "designer" as const, text: HOME_SUPPLIER_NOTES, model: "demo-supplier-notes" }];
    for (const [index, message] of messages.entries()) {
      await tx.insert(chatMessages).values({ caseId: row.id, id: discussionId(session, String(index)), actor: message.actor, text: message.text, model: message.model })
        .onConflictDoNothing({ target: [chatMessages.caseId, chatMessages.id] });
    }
    await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, row.id));
  });
}
