import { describe, expect, it } from "vitest";
import { willowApprovedQuote } from "@/quotes/willow-quote";
import { quoteFingerprint } from "@/quotes/fingerprint";
import type { CaseMessage, ProductPage } from "@/chat/types";
import { buildDraft } from "./draft";
import { modelContext } from "./model";

const messages: CaseMessage[] = [
  { id: "discussion", actor: "client", text: "我们讨论的是餐椅，不是书房椅子。", createdAt: "2026-10-18T10:00:00Z", replyToMessageId: null, aiState: "none", error: null, model: null },
  { id: "request", actor: "designer", text: "@AI，改成这个，4把，其他不动。https://shop.example/chair", createdAt: "2026-10-18T10:01:00Z", replyToMessageId: null, aiState: "running", error: null, model: null },
];
// Deliberately synthetic product input: real source retrieval is tested separately.
const page: ProductPage = {
  id: "page-test", url: "https://shop.example/chair", fetchedAt: "2026-10-18T10:01:01Z", title: "Test chair", text: "", error: null,
  products: [{ id: "page-test:0", name: "New dining chair", sku: "TEST-794", brand: "Test brand", seller: "Test store", specification: "Gray chair, two component packages per chair", currency: "USD", unitPriceCents: 12500, unitLabel: "each", priceEvidence: 'Offer: {"price":"125.00","priceCurrency":"USD"}', availability: null }],
};
const output = {
  intent: "draft" as const, message: "已整理为待设计师核价的餐椅替换草稿。", title: "餐椅换款",
  changes: [{ action: "replace" as const, itemId: "willow-lisabo-dining-chair", quantity: 4, productOptionId: "page-test:0", description: "New dining chair", sourceMessageIds: ["discussion", "request"] }],
  unresolved: [], constraints: ["其他不动"],
};

function input() {
  return { output: structuredClone(output), quote: willowApprovedQuote, messages: structuredClone(messages), pages: [structuredClone(page)], current: null, triggerId: "request", model: "test-model", now: "2026-10-18T10:02:00Z" };
}

describe("server-validated change drafts", () => {
  it("replaces four old chairs with four new chairs and computes a $180 pretax reference delta", () => {
    const original = JSON.stringify(willowApprovedQuote);
    const draft = buildDraft(input()).draft!;
    expect(draft.changes).toHaveLength(1);
    expect(draft.changes[0]).toMatchObject({ action: "replace", before: { quantity: 4, unitPriceCents: 8000 }, after: { quantity: 4, unitPriceCents: 12500 }, beforeSubtotalCents: 32000, afterSubtotalCents: 50000, deltaSubtotalCents: 18000 });
    expect(draft.status).toBe("needs_designer_review");
    expect(draft.basedOnQuoteFingerprint).toBe(quoteFingerprint(willowApprovedQuote));
    expect(draft.deltaSubtotalCents).toBe(18000);
    expect(draft.unresolved.join(" ")).toContain("旧款是否已采购");
    expect(draft.unresolved.join(" ")).toContain("税费");
    expect(JSON.stringify(willowApprovedQuote)).toBe(original);
    expect(draft.sources[0].text).toBe("");
  });
  it("rejects invented quote IDs, product IDs, foreign sources and repeated changes", () => {
    for (const invalid of [
      { itemId: "maple-chair" }, { productOptionId: "made-up" }, { sourceMessageIds: ["foreign-case-message"] },
    ]) {
      const data = input();
      Object.assign(data.output.changes[0], invalid);
      expect(() => buildDraft(data)).toThrow();
    }
    const duplicate = input();
    duplicate.output.changes.push(duplicate.output.changes[0]);
    expect(() => buildDraft(duplicate)).toThrow("Conflicting");
  });
  it("never accepts model-supplied prices or order actions", () => {
    const extraPrice = input();
    Object.assign(extraPrice.output.changes[0], { unitPriceCents: 1 });
    expect(() => buildDraft(extraPrice)).toThrow();
    const order = input();
    Object.assign(order.output.changes[0], { action: "pay" });
    expect(() => buildDraft(order)).toThrow();
  });
  it("keeps unknown currency, units and evidence out of monetary previews", () => {
    for (const patch of [{ currency: "EUR" }, { unitLabel: null }, { priceEvidence: null }, { unitPriceCents: null }]) {
      const data = input();
      Object.assign(data.pages[0].products[0], patch);
      const draft = buildDraft(data).draft!;
      expect(draft.deltaSubtotalCents).toBeNull();
      expect(draft.changes[0].deltaSubtotalCents).toBeNull();
    }
  });
  it("updates one draft relative to V1 without accumulating the same change", () => {
    const first = buildDraft(input()).draft!;
    const updated = buildDraft({ ...input(), current: first }).draft!;
    expect(updated.id).toBe(first.id);
    expect(updated.revision).toBe(2);
    expect(updated.deltaSubtotalCents).toBe(18000);
    expect(() => buildDraft({ ...input(), current: { ...first, projectKey: "maple" } })).toThrow();
  });
  it("allows clarifications and answers without replacing the current draft", () => {
    const result = buildDraft({ ...input(), output: { ...output, intent: "clarify", message: "要选哪一种颜色？", changes: [] } });
    expect(result.draft).toBeUndefined();
    expect(result.text).toBe("要选哪一种颜色？");
    expect(() => buildDraft({ ...input(), output: { ...output, intent: "answer" } })).toThrow();
  });
  it("can explicitly withdraw the current unapproved draft without changing V1", () => {
    const current = buildDraft(input()).draft!;
    const original = JSON.stringify(willowApprovedQuote);
    const result = buildDraft({ ...input(), current, output: { ...output, intent: "cancel", message: "已撤回当前草稿，仍按 V1；没有取消任何订单或执行支付。", changes: [] } });
    expect(result.draft).toBeNull();
    expect(JSON.stringify(willowApprovedQuote)).toBe(original);
    expect(() => buildDraft({ ...input(), output: { ...output, intent: "cancel", changes: [] } })).toThrow("No current draft");
  });
  it("keeps an unknown replacement useful while marking prices as pending", () => {
    const data = input();
    Object.assign(data.output.changes[0], { productOptionId: null, description: "那张还没报价的新餐椅" });
    const draft = buildDraft(data).draft!;
    expect(draft.changes[0].after?.quantity).toBe(4);
    expect(draft.changes[0].after?.unitPriceCents).toBeNull();
    expect(draft.deltaSubtotalCents).toBeNull();
  });
  it("preserves purchase-unit counts for pack and hourly quote lines", () => {
    for (const itemId of ["willow-solhetta-e26-bulbs", "willow-consultation"]) {
      const data = input();
      Object.assign(data.output.changes[0], { action: "quantity", itemId, quantity: 3, productOptionId: null });
      const change = buildDraft(data).draft!.changes[0];
      expect(change.after?.quantity).toBe(3);
      expect(change.after?.unitLabel).toBe(change.before?.unitLabel);
    }
  });
  it("includes all ordered messages and refuses excess context instead of truncating", () => {
    const context = JSON.parse(modelContext({ ...input(), current: null }));
    expect(context.messages.map((message: { id: string }) => message.id)).toEqual(["discussion", "request"]);
    const withCurrent = JSON.parse(modelContext({ ...input(), current: buildDraft(input()).draft! }));
    expect(withCurrent.currentDraft).not.toHaveProperty("basedOnQuoteFingerprint");
    expect(withCurrent.currentDraft.changes).toHaveLength(1);
    const data = input();
    data.messages[0].text = "长".repeat(120001);
    expect(() => modelContext(data)).toThrow("没有静默截断");
  });
});
