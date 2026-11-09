/**
 * Runs the real chat, draft, pricing review, issue and client confirmation flow
 * for one change, with a scripted draft instead of a model call. /try seeds its
 * starting state with it, and payment tests start from the same frozen versions,
 * hashes and business items the app creates.
 */
import { randomUUID } from "node:crypto";
import { buildDraft } from "../ai/draft";
import { createApprovalStore } from "../approval/store";
import { createChatStore } from "../chat/store";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { createPricingInput } from "../pricing/calculation";
import { createPricingStore } from "../pricing/store";
import type { FrozenChangeOrder, NonRefundableFee, OldItemHandling, PricingItem } from "../pricing/types";
import { clientSignatureName } from "../opening/types";

export interface ScriptedChange {
  action: "quantity" | "replace" | "remove";
  itemId: string;
  quantity?: number;
  /** Reviewed fields of the new or changed line, on top of what the draft carries. */
  after?: Partial<PricingItem>;
  oldItemHandling?: OldItemHandling;
  oldItemCostCents?: number;
  /** The fees that make up the old-item cost; without them, the whole cost is one restocking fee. */
  oldItemFees?: NonRefundableFee[];
}

/** The words each person writes along the way. */
export interface ScriptedCopy {
  /** The message after "@Setti". */
  request: string;
  /** The AI draft's reply and title. */
  reply: string;
  title: string;
  /** Recorded as the model name, so the chat labels the draft as scripted. */
  model: string;
  terms: string;
  reviewNotes: string;
  priceEvidence: string;
  oldItemNote: string;
  issueNote: string;
}

const testCopy = (names: string[], changes: ScriptedChange[]): ScriptedCopy => ({
  request: changes.map((change, index) => `${change.action} ${names[index]}`).join("; "),
  reply: "Test draft",
  title: `Test change: ${names.join("; ")}`,
  model: "test-model",
  terms: "Demo client confirms this complete quote; payment steps are separate.",
  reviewNotes: "Checked test amounts and terms.",
  priceEvidence: "Demonstration price reviewed for testing.",
  oldItemNote: "Checked old-item handling for this test.",
  issueNote: "Checked in this test fixture.",
});

/** Several changes share one draft, frozen document, approval and set of version hashes. */
export async function confirmScriptedChanges(
  db: Db, session: string, key: CaseKey, changes: ScriptedChange[],
  { confirm = true, copy = {}, actor = "client", expectedBaseline, note = "" }: { confirm?: boolean; copy?: Partial<ScriptedCopy>; actor?: "client" | "designer"; expectedBaseline?: { id: string; version: number }; note?: string } = {},
): Promise<FrozenChangeOrder> {
  if (!changes.length) throw new Error("Expected at least one scripted change");
  const chat = createChatStore(db), pricing = createPricingStore(db);
  const state = await chat.getCase(session, key);
  const quote = state.quote!;
  if (expectedBaseline && (quote.id !== expectedBaseline.id || quote.version !== expectedBaseline.version)) throw new Error("The prepared baseline advanced before its historical version was created. Resume the saved version.");
  const lines = changes.map((change) => {
    const line = quote.lines.find((entry) => entry.itemId === change.itemId);
    if (!line) throw new Error(`Unknown scripted item: ${change.itemId}`);
    return line;
  });
  const words = { ...testCopy(lines.map((line) => line.name), changes), ...copy };
  const id = randomUUID();
  await chat.appendMessage(session, key, { id, actor, text: `@Setti ${words.request}` });
  const run = await chat.beginAi(session, key, id);
  if (run.status !== "started") throw new Error("Expected an AI run");
  const result = buildDraft({
    quote, messages: run.state.messages, pages: [], current: state.draft, triggerId: id, model: words.model,
    output: {
      intent: "draft", message: words.reply, title: words.title, unresolved: [], constraints: [],
      changes: changes.map((change, index) => ({ action: change.action, itemId: change.itemId, quantity: change.action === "remove" ? null : change.quantity ?? change.after?.quantity ?? lines[index].quantity, productOptionId: null, description: change.action === "replace" ? "Replacement product" : "", sourceMessageIds: [id] })),
    },
  });
  // The saved draft also carries any V1 lines the server brings along, so price that one.
  const draft = (await chat.completeAi(session, key, id, run.runId, { ...result, model: words.model })).draft!;
  const workspace = await pricing.getWorkspace(session, key);
  const input = createPricingInput(quote, draft);
  input.terms = words.terms;
  input.reviewNotes = words.reviewNotes;
  input.changes = input.changes.map((entry, index) => {
    // A line coming back from V1 is already filled in from V1; the scripted designer confirms it as it is.
    if (entry.fromV1) return { ...entry, confirmed: true };
    const change = changes[index], line = lines[index];
    const reducing = change.action !== "quantity" || (change.quantity ?? line.quantity) < line.quantity;
    return {
      ...entry, confirmed: true, priceEvidence: words.priceEvidence,
      after: entry.after ? { ...entry.after, taxCents: 0, freightCents: 0, currency: "USD", sku: entry.after.sku || "DEMO", returnable: true, returnPolicy: entry.after.returnPolicy || "Demo test return terms checked.", ...change.after } : null,
      oldItemHandling: reducing ? change.oldItemHandling ?? "not_ordered" : "not_applicable",
      oldItemCostCents: reducing ? change.oldItemCostCents ?? 0 : 0,
      oldItemFees: !reducing ? [] : change.oldItemFees ?? (change.oldItemCostCents ? [{ kind: "restocking_fee" as const, amountCents: change.oldItemCostCents }] : []),
      oldItemNote: reducing ? words.oldItemNote : "",
    };
  });
  input.issues = input.issues.map((issue) => ({ ...issue, resolved: true, note: words.issueNote }));
  const saved = await pricing.saveReview(session, key, { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: workspace.review?.version || null, input });
  const issued = await pricing.issueReview(session, key, { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
  const order = issued.order;
  if (confirm) {
    await createApprovalStore(db).decide(session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note });
  }
  return order;
}

export const shown = (order: FrozenChangeOrder) => ({ contentHash: order.contentHash, revisionContentHash: order.revisionContentHash });
