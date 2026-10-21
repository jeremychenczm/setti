/**
 * Test fixture: runs the real chat, draft, pricing review, issue and client
 * confirmation flow for one change, with a fixed draft instead of a model call.
 * Payment tests start from the same frozen versions, hashes and business items
 * the app creates.
 */
import { randomUUID } from "node:crypto";
import { buildDraft } from "../../ai/draft";
import { createApprovalStore } from "../../approval/store";
import { createChatStore } from "../../chat/store";
import type { CaseKey } from "../../chat/types";
import type { Db } from "../../db/client";
import { createPricingInput } from "../../pricing/calculation";
import { createPricingStore } from "../../pricing/store";
import type { FrozenChangeOrder, OldItemHandling, PricingItem } from "../../pricing/types";

export interface TestChange {
  action: "quantity" | "replace" | "remove";
  itemId: string;
  quantity?: number;
  /** Reviewed fields of the new or changed line, on top of what the draft carries. */
  after?: Partial<PricingItem>;
  oldItemHandling?: OldItemHandling;
  oldItemCostCents?: number;
}

/** The demo chair replacement: four BERGMUND chairs at $125 with $43.75 recorded tax ($543.75). */
export const bergmund = (quantity = 4, taxCents = 4_375): Partial<PricingItem> => ({
  name: "BERGMUND Chair - oak effect/Orrsta light gray", vendor: "IKEA", brand: "IKEA", sku: "794.717.09",
  specification: "BERGMUND Chair - oak effect/Orrsta light gray", unitLabel: "item", currency: "USD",
  quantity, unitPriceCents: 12_500, taxCents, freightCents: 0,
  sourceUrl: "https://www.ikea.com/us/en/p/bergmund-chair-oak-effect-orrsta-light-gray-s79471709/",
  returnPolicy: "Demo terms: returnable subject to the seller's policy.", returnable: true,
});

/** Issues one reviewed change for the session's case and, unless `confirm` is false, confirms it as the demo client. */
export async function confirmChange(db: Db, session: string, key: CaseKey, change: TestChange, confirm = true): Promise<FrozenChangeOrder> {
  const chat = createChatStore(db), pricing = createPricingStore(db);
  const state = await chat.getCase(session, key);
  const quote = state.quote!;
  const line = quote.lines.find((entry) => entry.itemId === change.itemId)!;
  const id = randomUUID();
  await chat.appendMessage(session, key, { id, actor: "client", text: `@AI ${change.action} ${line.name}` });
  const run = await chat.beginAi(session, key, id);
  if (run.status !== "started") throw new Error("Expected an AI run");
  const result = buildDraft({
    quote, messages: run.state.messages, pages: [], current: state.draft, triggerId: id, model: "test-model",
    output: {
      intent: "draft", message: "Test draft", title: `Test ${change.action}: ${line.name}`, unresolved: [], constraints: [],
      changes: [{ action: change.action, itemId: change.itemId, quantity: change.action === "remove" ? null : change.quantity ?? change.after?.quantity ?? line.quantity, productOptionId: null, description: change.action === "replace" ? "Replacement product" : "", sourceMessageIds: [id] }],
    },
  });
  await chat.completeAi(session, key, id, run.runId, { ...result, model: "test-model" });
  const draft = result.draft!;
  const workspace = await pricing.getWorkspace(session, key);
  const input = createPricingInput(quote, draft);
  input.terms = "Demo client confirms this complete quote; payment steps are separate.";
  input.reviewNotes = "Checked test amounts and terms.";
  const reducing = change.action !== "quantity" || (change.quantity ?? line.quantity) < line.quantity;
  input.changes = input.changes.map((entry) => ({
    ...entry, confirmed: true, priceEvidence: "Demonstration price reviewed for testing.",
    after: entry.after ? { ...entry.after, taxCents: 0, freightCents: 0, currency: "USD", sku: entry.after.sku || "DEMO", returnable: true, returnPolicy: entry.after.returnPolicy || "Demo test return terms checked.", ...change.after } : null,
    oldItemHandling: reducing ? change.oldItemHandling ?? "not_ordered" : "not_applicable",
    oldItemCostCents: reducing ? change.oldItemCostCents ?? 0 : 0,
    oldItemNote: reducing ? "Checked old-item handling for this test." : "",
  }));
  input.issues = input.issues.map((issue) => ({ ...issue, resolved: true, note: "Checked in this test fixture." }));
  const saved = await pricing.saveReview(session, key, { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: workspace.review?.version || null, input });
  const issued = await pricing.issueReview(session, key, { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
  const order = issued.order;
  if (confirm) {
    await createApprovalStore(db).decide(session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: order.clientName, note: "" });
  }
  return order;
}

export const shown = (order: FrozenChangeOrder) => ({ contentHash: order.contentHash, revisionContentHash: order.revisionContentHash });
