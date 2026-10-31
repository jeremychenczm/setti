/** The living-and-dining preparation history, separate from the visitor's live AI discussion. */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApprovalStore } from "../approval/store";
import { chatCases, chatMessages } from "../chat/schema";
import type { Db } from "../db/client";
import { approvals, revisions } from "../db/schema";
import { HOME_APPROVED_QUOTE, HOME_DISCUSSION, HOME_LEGACY_SCENARIO, HOME_SCENARIO, HOME_SUPPLIER_NOTES } from "../demo/living-dining";
import { documentHash, withoutApproval } from "../opening/document";
import { openingQuotes } from "../opening/schema";
import { clientSignatureName } from "../opening/types";
import { insertBaseline } from "../pricing/bridge";
import { changeOrders, pricingCases } from "../pricing/schema";
import type { FrozenChangeOrder } from "../pricing/types";
import type { ApprovedQuoteReport } from "../quotes/types";
import { MaplePreparationError } from "./maple";
import { confirmScriptedChanges, shown } from "./scripted-change";

const preparedClarification = "Fictional prepared agreement: client approval alone does not place a supplier order or establish payment.";
const preparedTerms = (policy: string | null) => `${policy ?? ""} ${preparedClarification}`.trim();

async function ensureBaseline(db: Db, session: string, opening = false): Promise<ApprovedQuoteReport> {
  return db.transaction(async (tx) => {
    await tx.insert(chatCases).values({ sessionId: session, projectKey: "maple" }).onConflictDoNothing({ target: [chatCases.sessionId, chatCases.projectKey] });
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, "maple"))).for("update");
    const [existing] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, row.id));
    if (existing) {
      if (existing.baselineQuote?.id !== HOME_APPROVED_QUOTE.id) throw new MaplePreparationError("This workspace has another scenario's baseline. Its existing payments were left unchanged.", false);
      return existing.baselineQuote;
    }
    const quote = structuredClone(HOME_APPROVED_QUOTE);
    const { bridge, revisionHash, lineIds } = await insertBaseline(tx, row.id, quote, quote);
    if (opening) {
      const messageId = discussionId(session, "opening-v1", HOME_SCENARIO);
      const document = withoutApproval(quote);
      await tx.insert(chatMessages).values({ caseId: row.id, id: messageId, actor: "designer", model: "demo-prepared-history", text: "Prepared project history: Emma has confirmed this original living-and-dining quote V1. The design discussion below leads to the first revision.", createdAt: new Date(quote.approvedAt) });
      await tx.insert(openingQuotes).values({ caseId: row.id, messageId, document, contentHash: documentHash(document), sentBy: quote.designerName, sentAt: new Date(quote.approvedAt) });
    }
    const signingId = opening ? randomUUID() : null;
    for (const line of quote.lines) {
      await tx.insert(approvals).values({
        revisionId: bridge.baselineRevisionId, revisionLineId: lineIds.get(line.itemId)!, decision: "approved",
        approverName: line.approval.approvedBy, signature: line.approval.signature,
        contentHash: revisionHash, decidedAt: new Date(line.approval.approvedAt),
        signingId,
      });
    }
    // A signed opening remains 'sent' until a later version supersedes it, as for Willow.
    if (!opening) await tx.update(revisions).set({ status: "approved" }).where(eq(revisions.id, bridge.baselineRevisionId));
    return quote;
  });
}

/** Only local records: make the agreed V1 and discussion available before any provider call. */
export async function ensureHomeWorkspace(db: Db, session: string): Promise<ApprovedQuoteReport> {
  const quote = await ensureBaseline(db, session, true);
  await appendHomeDiscussion(db, session);
  return quote;
}

/** Reuse the same historical V2, including after a worker stopped before saving its stage. */
export async function ensureHomeQuote(db: Db, session: string): Promise<FrozenChangeOrder> {
  const quote = await ensureBaseline(db, session);
  const [existing] = await db.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
    .innerJoin(chatCases, eq(chatCases.id, changeOrders.caseId)).innerJoin(revisions, eq(revisions.id, changeOrders.revisionId))
    .where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, "maple"), eq(revisions.number, 2)));
  if (existing) {
    const order = existing.document;
    if (order.lines.length !== quote.lines.length || quote.lines.some((line) => {
      const prepared = order.lines.find((entry) => entry.itemId === line.itemId);
      return !prepared || prepared.sku !== line.sku
        || prepared.quantity !== line.quantity || prepared.unitPriceCents !== line.unitPriceCents
        || prepared.specification !== line.specification
        || prepared.returnPolicy !== (line.category === "furniture" ? preparedTerms(line.returnPolicy) : line.returnPolicy)
        || prepared.taxCents !== line.taxCents || prepared.freightCents !== line.freightCents;
    })) throw new MaplePreparationError("This workspace's V2 differs from its prepared living-and-dining agreement. Its money was left unchanged.", false);
    if (existing.status !== "sent" && existing.status !== "approved") throw new MaplePreparationError("A later version replaced the prepared agreement. Continue the existing project instead of preparing more money.", false);
    if (existing.status === "sent") await createApprovalStore(db).decide(session, order.id, {
      decision: "approved", ...shown(order), acknowledged: true, signature: clientSignatureName(order), note: "Prepared demo history.",
    });
    return order;
  }
  return confirmScriptedChanges(db, session, "maple", quote.lines.filter((line) => line.category === "furniture").map((line) => ({
    action: "quantity" as const, itemId: line.itemId, quantity: line.quantity,
    after: {
      name: line.name, vendor: line.vendor, brand: null, sku: line.sku,
      specification: line.specification, category: line.category, room: line.room,
      quantity: line.quantity, unitLabel: line.unitLabel ?? "each", currency: "USD",
      unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
      returnPolicy: preparedTerms(line.returnPolicy), restockingFeeBps: line.restockingFeeBps,
      customMade: line.customMade, leadTimeDays: line.leadTimeDays,
      sourceUrl: line.source.url ?? null, returnable: line.nonReturnable === null ? null : !line.nonReturnable,
    }, oldItemHandling: "not_ordered" as const, oldItemCostCents: 0,
  })), { actor: "designer", expectedBaseline: { id: quote.id, version: quote.version }, copy: {
    request: "Prepared demo history: import the already agreed living-and-dining furniture at the same prices and quantities; keep the design service unchanged.",
    reply: "Prepared demonstration history only: the agreed six-line quote is carried into V2 unchanged in price and quantity. This is not the visitor's live AI proposal.",
    title: "Prepared living-and-dining agreement", model: "demo-prepared-history",
    terms: "Fictional prepared agreement. Five furniture lines and the unchanged design service. The original products, specifications, quantities and prices are unchanged; V2 clarifies that quote approval is separate from supplier orders and payment evidence.",
    reviewNotes: "Demo setup preserves the original agreed products, specifications, quantities and prices. V2 adds a payment/order clarification to each furniture line's existing return terms. No visitor revision has been drafted or approved.",
    priceEvidence: "Fictional scenario supplier material and the persisted original quote, checked for this demonstration.",
    oldItemNote: "The baseline fixture product was not ordered; no retained old-item cost.", issueNote: "Prepared demonstration fixture checked.",
  } });
}

/** Stable UUIDs and one transaction prevent a resumed final stage from repeating the conversation. */
function discussionId(session: string, entry: string, scenario: string): string {
  const hex = createHash("sha256").update(`${scenario}:${session}:${entry}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function appendHomeDiscussion(db: Db, session: string, initial?: FrozenChangeOrder): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, "maple"))).for("update");
    if (!row) throw new MaplePreparationError("The prepared discussion workspace is unavailable.");
    const messages = [...HOME_DISCUSSION.map((message) => ({ ...message, model: "demo-scenario-discussion" })),
      { actor: "designer" as const, text: HOME_SUPPLIER_NOTES, model: "demo-supplier-notes" }];
    for (const [index, message] of messages.entries()) {
      await tx.insert(chatMessages).values({ caseId: row.id, id: discussionId(session, String(index), initial ? HOME_LEGACY_SCENARIO : HOME_SCENARIO), actor: message.actor, text: message.text, model: message.model })
        .onConflictDoNothing({ target: [chatMessages.caseId, chatMessages.id] });
    }
    const preparedDraft = !!initial && row.draft?.id === initial.sourceDraftId && row.draft.revision === initial.sourceDraftRevision;
    await tx.update(chatCases).set({ ...(preparedDraft ? { draft: null } : {}), updatedAt: new Date() }).where(eq(chatCases.id, row.id));
  });
}
