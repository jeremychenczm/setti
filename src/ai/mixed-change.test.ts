import { describe, expect, it } from "vitest";
import type { CaseMessage, ChangeDraft, ProductPage } from "@/chat/types";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { createPricingInput, prepareChangeOrder } from "@/pricing/calculation";
import { buildDraft } from "./draft";
import { modelContext } from "./model";
import type { AiOutput } from "./output";

const now = "2026-10-21T12:00:00.000Z";
const message = (id: string, text: string, actor: "client" | "designer" = "client"): CaseMessage => ({
  id, text, actor, createdAt: now, replyToMessageId: null, aiState: "none", error: null, model: null,
});
const messages: CaseMessage[] = [
  message("chair-request", "窗边单椅换成这张书桌，一张。https://shop.example.com/desk"),
  message("rug-request", "地毯也退掉。"),
  message("request", "@AI 把刚才单椅换书桌、退地毯的讨论整理在同一份变更里。", "designer"),
];
// Synthetic source input; real product-page retrieval has separate tests.
const page: ProductPage = {
  id: "desk-page", url: "https://shop.example.com/desk", fetchedAt: now, title: "Sample desk", text: "", error: null,
  products: [{ id: "desk-page:0", name: "Oak writing desk", brand: "Sample", seller: "Sample furniture", sku: "DESK-01", specification: "Natural oak writing desk", currency: "USD", unitPriceCents: 110_000, unitLabel: "each", priceEvidence: '{"price":"1100.00","priceCurrency":"USD"}', availability: null }],
};
function output(): AiOutput {
  return {
    intent: "draft", title: "单椅换书桌并退地毯", message: "两项变更已整理为同一份待设计师核价草稿。", unresolved: [], constraints: [],
    changes: [
      { action: "replace", itemId: "chair", quantity: 1, productOptionId: "desk-page:0", description: "Oak writing desk", sourceMessageIds: ["chair-request"] },
      { action: "remove", itemId: "rug", quantity: null, productOptionId: null, description: "", sourceMessageIds: ["rug-request"] },
    ],
  };
}
function input(current: ChangeDraft | null = null) {
  return { output: output(), quote: structuredClone(mapleApprovedQuote), messages: structuredClone(messages), pages: [structuredClone(page)], current, triggerId: "request", model: "test-model", now };
}

describe("one draft for multiple original items", () => {
  it("keeps a sourced replacement and a separate removal together without changing the approved quote", () => {
    const data = input();
    const before = structuredClone(data.quote);
    const draft = buildDraft(data).draft!;
    expect(draft.changes).toHaveLength(2);
    expect(draft.changes[0]).toMatchObject({
      action: "replace", itemId: "chair", before: { name: "Lounge chair", unitPriceCents: 80_000 },
      after: { name: "Oak writing desk", quantity: 1, unitPriceCents: 110_000 }, deltaSubtotalCents: 30_000,
      sourceMessageIds: ["chair-request", "request"],
    });
    expect(draft.changes[1]).toMatchObject({
      action: "remove", itemId: "rug", before: { name: "Wool rug", unitPriceCents: 30_000 }, after: null,
      deltaSubtotalCents: -30_000, sourceMessageIds: ["rug-request", "request"],
    });
    // Equal product subtotals do not imply a no-op or a settled payment.
    expect(draft.deltaSubtotalCents).toBe(0);
    expect(draft.status).toBe("needs_designer_review");
    expect(draft.unresolved.join(" ")).toContain("Lounge chair");
    expect(draft.unresolved.join(" ")).toContain("Wool rug");
    expect(data.quote).toEqual(before);
  });

  it("carries the whole change set into one reviewed document with independent old-item handling", () => {
    const data = input();
    const draft = buildDraft(data).draft!;
    const review = createPricingInput(data.quote, draft);
    review.terms = "Demo: chair not ordered; rug return retains USD 60 and needs supplier credit before refund. New desk requires supplier confirmation.";
    review.changes.forEach((entry) => {
      entry.confirmed = true;
      entry.oldItemHandling = entry.itemId === "rug" ? "returned" : "not_ordered";
      entry.oldItemCostCents = entry.itemId === "rug" ? 6_000 : 0;
      entry.oldItemNote = entry.itemId === "rug" ? "Demo rug restocking fee checked: 20% of USD 300, inclusive total USD 60." : "Original chair has not been ordered; no retained cost.";
      entry.priceEvidence ||= "Designer checked the demo rug return terms.";
      if (entry.after) Object.assign(entry.after, { taxCents: 0, freightCents: 0, returnPolicy: "Demo desk terms checked by designer.", returnable: true });
    });
    review.issues.forEach((issue) => { issue.resolved = true; issue.note = "Designer checked against the demo quote and terms."; });
    const document = prepareChangeOrder(data.quote, draft, review, data.messages);
    expect(document.changes.map((change) => [change.itemId, change.action, change.oldItemHandling, change.oldItemCostCents])).toEqual([
      ["chair", "replace", "not_ordered", 0], ["rug", "remove", "returned", 6_000],
    ]);
    expect(document.lines.find((line) => line.itemId === "design")?.origin).toBe("unchanged");
    expect(document.lines.find((line) => line.itemId === "chair")).toMatchObject({ name: "Oak writing desk", unitPriceCents: 110_000 });
    expect(document.lines.some((line) => line.itemId === "rug")).toBe(false);
    expect(document.lines.filter((line) => line.origin === "old_item_cost")).toEqual([expect.objectContaining({ itemId: `old-cost-${draft.id}-change-1`, unitPriceCents: 6_000 })]);
    expect(document.baselineTotals.totalCents).toBe(150_000);
    expect(document.totals.totalCents).toBe(156_000);
    expect(document.deltaTotalCents).toBe(6_000);
    expect(document.sourceMessages.map((entry) => entry.id)).toEqual(["chair-request", "rug-request", "request"]);
  });

  it("updates one item's quantity while retaining the other item's removal relative to V1", () => {
    const first = buildDraft(input()).draft!;
    const data = input(first);
    data.messages.push(message("correction", "@AI 书桌改为两张，地毯仍然退掉。"));
    data.triggerId = "correction";
    data.output.changes[0].quantity = 2;
    data.output.changes[0].sourceMessageIds.push("correction");
    const context = JSON.parse(modelContext(data));
    expect(context.currentDraft.changes.map((entry: { itemId: string }) => entry.itemId)).toEqual(["chair", "rug"]);
    const corrected = buildDraft(data).draft!;
    expect(corrected.id).toBe(first.id);
    expect(corrected.revision).toBe(2);
    expect(corrected.changes[0]).toMatchObject({ before: { quantity: 1, unitPriceCents: 80_000 }, after: { quantity: 2, unitPriceCents: 110_000 } });
    expect(corrected.changes[1]).toMatchObject({ action: "remove", itemId: "rug", after: null });
    expect(corrected.deltaSubtotalCents).toBe(110_000);
    expect(first.changes[0].after?.quantity).toBe(1);
  });

  it("can withdraw only the rug change without cancelling the chair replacement draft", () => {
    const current = buildDraft(input()).draft!;
    const data = input(current);
    data.messages.push(message("keep-rug", "@AI 地毯不退了，单椅换书桌的变更保留。"));
    data.triggerId = "keep-rug";
    data.output.changes = [data.output.changes[0]];
    const revised = buildDraft(data).draft!;
    expect(revised.id).toBe(current.id);
    expect(revised.changes).toHaveLength(1);
    expect(revised.changes[0]).toMatchObject({ action: "replace", itemId: "chair" });
    expect(revised.deltaSubtotalCents).toBe(30_000);
  });

  it("rejects the complete result when another action duplicates an identity or cites an unrelated source", () => {
    for (const invalid of [{ itemId: "chair" }, { itemId: "unknown-item" }, { sourceMessageIds: ["foreign-project-message"] }]) {
      const data = input();
      const approvedBefore = structuredClone(data.quote);
      Object.assign(data.output.changes[1], invalid);
      expect(() => buildDraft(data)).toThrow();
      expect(data.quote).toEqual(approvedBefore);
    }
  });
});
