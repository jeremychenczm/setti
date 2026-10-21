import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovedQuoteLine, ApprovedQuoteReport } from "@/quotes/types";
import type { CaseMessage, ChangeDraft, DraftChange, DraftItem } from "@/chat/types";
import type { PricingInput } from "./types";
import { quoteFingerprint } from "../quotes/fingerprint";
import { createPricingInput, prepareChangeOrder, previewPricing, PricingValidationError, pricingInputSchema, requiresOldItemHandling, validatePricingInput } from "./calculation";

const date = "2026-10-20T12:00:00.000Z";
function line(id = "chair"): ApprovedQuoteLine {
  return { itemId: id, name: id === "chair" ? "Original chair" : "Original rug", vendor: "Original dealer", category: "furniture", room: "Living", sku: `ORIGINAL-${id}`, specification: "Original approved specification", quantity: id === "chair" ? 2 : 1, unitLabel: "each", unitPriceCents: id === "chair" ? 10_000 : 30_000, taxCents: id === "chair" ? 1_500 : 2_400, freightCents: id === "chair" ? 500 : 600, source: { kind: "public_reference", reference: "original-reference", name: "Original quote", note: "Verified for test", url: "https://retailer.example.com/original" }, leadTimeDays: 14, returnPolicy: "Original agreed return terms", restockingFeeBps: null, customMade: false, nonReturnable: null, approval: { status: "approved", approvedBy: "Test client", approvedAt: date, signature: "Test only", isDemo: true } };
}
function quote(): ApprovedQuoteReport {
  return { id: "quote-v1", version: 1, projectId: "willow", projectName: "Willow", room: "Living", clientName: "Test client", designerName: "Test designer", currency: "USD", status: "approved", approvedAt: date, approvedBy: "Test client", signature: "Test only", isDemo: true, demoNotice: "Demo", paymentNote: "Not payment", assumptions: [], lines: [line(), line("rug")] };
}
function item(old: ApprovedQuoteLine): DraftItem {
  return { name: old.name, vendor: old.vendor, brand: null, sku: old.sku, specification: old.specification, quantity: old.quantity, unitLabel: old.unitLabel ?? "each", unitPriceCents: old.unitPriceCents, currency: "USD" };
}
function change(action: DraftChange["action"] = "replace", id = "chair"): DraftChange {
  const before = action === "add" ? null : item(line(id));
  const after = action === "remove" ? null : action === "quantity" ? { ...before!, quantity: 3 } : { name: "New chair", vendor: "New dealer", brand: "New brand", sku: "NEW-CHAIR", specification: "Gray oak chair", quantity: 4, unitLabel: "item", unitPriceCents: 12_500, currency: "USD" };
  return { action, itemId: action === "add" ? null : id, before, after, productOptionId: action === "replace" || action === "add" ? "page-source:0" : null, sourceMessageIds: ["m2"], beforeSubtotalCents: 1, afterSubtotalCents: 1, deltaSubtotalCents: 0 };
}
function draft(changes: DraftChange[] = [change()]): ChangeDraft {
  return { id: "draft-1", projectKey: "willow", basedOnQuoteId: "quote-v1", basedOnVersion: 1, basedOnQuoteFingerprint: quoteFingerprint(quote()), revision: 2, status: "needs_designer_review", title: "Reviewed furniture change", summary: "A test draft", changes, sourceMessageIds: ["m1"], sources: [{ id: "page-source", url: "https://retailer.example.com/new-chair", fetchedAt: date, title: "New chair", text: "Source text", error: null, products: [{ id: "page-source:0", name: "New chair", sku: "NEW-CHAIR", brand: "New brand", seller: "New dealer", specification: "Gray oak chair", currency: "USD", unitPriceCents: 12_500, unitLabel: "item", priceEvidence: '{"offers":{"price":"125.00","priceCurrency":"USD"}}', availability: null }] }], unresolved: ["Check tax", "Check old order"], constraints: ["No purchase or money movement"], deltaSubtotalCents: 0, createdAt: date, updatedAt: date, model: "test-model" };
}
function messages(): CaseMessage[] {
  return ["m1", "m2", "unused"].map((id) => ({ id, actor: "client", text: `Original text ${id}`, createdAt: date, replyToMessageId: null, aiState: "none", error: null, model: null }));
}
function ready(q: ApprovedQuoteReport, d: ChangeDraft): PricingInput {
  const input = createPricingInput(q, d);
  input.terms = "Prices, tax, delivery and old-item costs were reviewed; nothing has been paid or approved by the client.";
  for (const entry of input.changes) {
    entry.confirmed = true;
    if (entry.after) { entry.after.taxCents = 500; entry.after.freightCents = 100; entry.after.returnPolicy = "Designer checked cancellation terms; delivery timing remains unconfirmed."; }
    if (requiresOldItemHandling(entry, q.lines.find((old) => old.itemId === entry.itemId))) { entry.oldItemHandling = "returned"; entry.oldItemCostCents = 2_000; entry.oldItemNote = "Confirmed total old-item cost, including any relevant tax and fees."; }
  }
  for (const issue of input.issues) { issue.resolved = true; issue.note = "Designer checked this issue against source documents."; }
  return input;
}

describe("pricing review calculation", () => {
  it("starts tax, delivery, old-item handling and confirmations unknown without inventing zero", () => {
    const q = quote(); const d = draft(); const input = createPricingInput(q, d);
    expect(input.changes[0]).toMatchObject({ key: "change-0", confirmed: false, oldItemHandling: "pending", oldItemCostCents: null, after: { name: "New chair", unitPriceCents: 12_500, taxCents: null, freightCents: null, returnPolicy: "", returnable: null, leadTimeDays: null } });
    expect(input.changes[0].priceEvidence).toContain('"price":"125.00"');
    expect(input.issues).toEqual([{ id: "issue-0", label: "Check tax", resolved: false, note: "" }, { id: "issue-1", label: "Check old order", resolved: false, note: "" }]);
    expect(previewPricing(q, d, input)).toMatchObject({ proposedTotals: null, deltaTotalCents: null, ready: false });
    expect(validatePricingInput(q, d, input)).toEqual(input);
  });

  it("preserves unknown/foreign currency and units for designer review", () => {
    const d = draft(); Object.assign(d.changes[0].after!, { currency: "EUR", unitLabel: null, unitPriceCents: null, vendor: null, sku: null });
    const input = createPricingInput(quote(), d);
    expect(input.changes[0].after).toMatchObject({ currency: "EUR", unitLabel: "", unitPriceCents: null, vendor: "", sku: "" });
    expect(validatePricingInput(quote(), d, input).changes[0].after?.currency).toBe("EUR");
    const unknown = structuredClone(d); unknown.changes[0].after!.currency = null;
    expect(createPricingInput(quote(), unknown).changes[0].after?.currency).toBeNull();
  });

  it("quantity increases need new tax and freight confirmation but no old handling", () => {
    const d = draft([change("quantity")]); const input = createPricingInput(quote(), d);
    expect(input.changes[0]).toMatchObject({ oldItemHandling: "not_applicable", oldItemCostCents: 0, after: { taxCents: null, freightCents: null } });
    expect(input.changes[0].priceEvidence).toContain("original-reference");
  });

  it("requires fresh USD evidence rather than only relabeling a foreign amount", () => {
    const q = quote(); const d = draft(); d.changes[0].after!.currency = "EUR";
    d.sources[0].products[0].currency = "EUR";
    d.sources[0].products[0].priceEvidence = '{"price":"125.00","priceCurrency":"EUR"}';
    const input = ready(q, d); input.changes[0].after!.currency = "USD";
    expect(previewPricing(q, d, input).problems.join()).toContain("不能只修改币种标签");
    input.changes[0].priceEvidence += " Designer obtained a separate USD vendor quote: USD 125 per item.";
    expect(previewPricing(q, d, input).ready).toBe(true);
  });

  it("creates a complete V2, keeps the untouched rug and adds one inclusive old-cost fee", () => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    const preview = previewPricing(q, d, input);
    // New chair: 4 * 12500 + 500 tax + 100 delivery, once per line.
    // Untouched rug: 33000; all-inclusive old-item cost: 2000.
    expect(preview).toMatchObject({ ready: true, baselineTotals: { totalCents: 55_000 }, proposedTotals: { totalCents: 85_600, lineCount: 3 }, deltaTotalCents: 30_600 });
    const body = prepareChangeOrder(q, d, input, messages());
    expect(body.lines.find((entry) => entry.itemId === "rug")).toMatchObject({ origin: "unchanged", unitPriceCents: 30_000, taxCents: 2_400, freightCents: 600 });
    expect(body.lines.find((entry) => entry.origin === "old_item_cost")).toMatchObject({ itemId: "old-cost-draft-1-change-0", quantity: 1, category: "service", unitPriceCents: 2_000, taxCents: 0, freightCents: 0 });
    expect(body.lines.find((entry) => entry.origin === "old_item_cost")?.specification).toContain("全部已核实成本");
    expect(body.changes[0].before?.unitPriceCents).toBe(10_000);
    expect(body.changes[0].before?.quantity).toBe(2);
    expect(body.constraints).toEqual(d.constraints);
    expect(body.sourceMessages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(body).not.toHaveProperty("payment");
  });

  it("old handling uses server-owned quote even if AI before/subtotals are wrong", () => {
    const q = quote(); const d = draft(); d.changes[0].before!.unitPriceCents = 1;
    const input = ready(q, d); input.changes[0].oldItemHandling = "retained"; input.changes[0].oldItemCostCents = 21_999;
    expect(previewPricing(q, d, input).problems.join()).toContain("原报价整行总额");
    input.changes[0].oldItemCostCents = 22_000;
    expect(previewPricing(q, d, input).ready).toBe(true);
    expect(prepareChangeOrder(q, d, input, messages()).changes[0].before?.unitPriceCents).toBe(10_000);
  });

  it("retains no removed old line and includes only explicitly confirmed removal cost", () => {
    const q = quote(); const d = draft([change("remove")]); const input = ready(q, d);
    input.changes[0].oldItemHandling = "not_ordered"; input.changes[0].oldItemCostCents = 0;
    const body = prepareChangeOrder(q, d, input, messages());
    expect(body.lines.map((entry) => entry.itemId)).toEqual(["rug"]);
    expect(body.changes[0].after).toBeNull();
    expect(body.deltaTotalCents).toBe(-22_000);
  });

  it("handles multiple changes, additions and removals with stable logical IDs", () => {
    const q = quote(); const d = draft([change("quantity"), change("remove", "rug"), change("add")]); const input = ready(q, d);
    input.changes[1].oldItemCostCents = 0;
    const first = prepareChangeOrder(q, d, input, messages());
    const second = prepareChangeOrder(q, d, input, messages());
    expect(first.lines.map((entry) => entry.itemId)).toEqual(["chair", "new-draft-1-change-2"]);
    expect(first).toEqual(second);
    expect(first.lines[0].quantity).toBe(3);
    expect(first.totals.totalCents).toBe(81_200);
  });

  it("requires explicit old handling for quantity reductions", () => {
    const q = quote(); const c = change("quantity"); c.after!.quantity = 1; const d = draft([c]);
    const input = createPricingInput(q, d);
    expect(input.changes[0]).toMatchObject({ oldItemHandling: "pending", oldItemCostCents: null });
    expect(requiresOldItemHandling(input.changes[0], q.lines[0])).toBe(true);
    const checked = ready(q, d); checked.changes[0].oldItemHandling = "retained"; checked.changes[0].oldItemCostCents = 9_999;
    expect(previewPricing(q, d, checked).ready).toBe(false);
    checked.changes[0].oldItemCostCents = 10_000;
    const body = prepareChangeOrder(q, d, checked, messages());
    expect(body.lines.find((entry) => entry.itemId === "chair")?.quantity).toBe(1);
    expect(body.lines.find((entry) => entry.origin === "old_item_cost")?.unitPriceCents).toBe(10_000);
    expect(body.totals.totalCents).toBe(53_600);
  });

  it("rechecks old handling if a designer changes an increase into a decrease", () => {
    const q = quote(); const d = draft([change("quantity")]); const input = ready(q, d);
    input.changes[0].after!.quantity = 1;
    expect(() => validatePricingInput(q, d, input)).toThrow(PricingValidationError);
    input.changes[0].oldItemHandling = "pending"; input.changes[0].oldItemCostCents = null;
    expect(validatePricingInput(q, d, input).changes[0].oldItemHandling).toBe("pending");
    expect(previewPricing(q, d, input).ready).toBe(false);
  });

  it.each(["key", "action", "itemId", "extraBefore"])("rejects forged change identity or nested fields: %s", (field) => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    const raw = input as unknown as { changes: Record<string, unknown>[] };
    if (field === "extraBefore") raw.changes[0].before = { unitPriceCents: 1 };
    else raw.changes[0][field] = field === "action" ? "remove" : "forged";
    expect(() => validatePricingInput(q, d, input)).toThrow();
  });

  it("rejects deleted, duplicate or injected changes and issues, including changed issue labels", () => {
    const q = quote(); const d = draft();
    const corruptions = [
      (input: PricingInput) => { input.changes = []; },
      (input: PricingInput) => { input.changes.push(structuredClone(input.changes[0])); },
      (input: PricingInput) => { input.issues.pop(); },
      (input: PricingInput) => { input.issues[0].label = "No longer needs confirmation"; },
      (input: PricingInput) => { input.issues[0].id = "issue-999"; },
      (input: PricingInput) => { input.issues.push({ id: "injected", label: "new", resolved: true, note: "new" }); },
    ];
    for (const corrupt of corruptions) { const input = ready(q, d); corrupt(input); expect(() => validatePricingInput(q, d, input)).toThrow(); }
  });

  it("canonicalizes reordered entries without changing their keys or source issue text", () => {
    const q = quote(); const d = draft([change("quantity"), change("remove", "rug")]); const input = ready(q, d);
    input.changes.reverse(); input.issues.reverse();
    const checked = validatePricingInput(q, d, input);
    expect(checked.changes.map((entry) => entry.key)).toEqual(["change-0", "change-1"]);
    expect(checked.issues.map((issue) => issue.id)).toEqual(["issue-0", "issue-1"]);
  });

  it.each(["name", "vendor", "sku", "specification", "room", "unitLabel", "returnPolicy"])("requires reviewed after field %s before issuing", (field) => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    (input.changes[0].after as unknown as Record<string, unknown>)[field] = "   ";
    expect(validatePricingInput(q, d, input)).toBeTruthy();
    expect(previewPricing(q, d, input).ready).toBe(false);
    expect(() => prepareChangeOrder(q, d, input, messages())).toThrow(PricingValidationError);
  });

  it("needs row confirmation, issue notes, price evidence and terms even when totals are known", () => {
    const q = quote(); const d = draft();
    const changes = [(input: PricingInput) => { input.changes[0].confirmed = false; }, (input: PricingInput) => { input.changes[0].priceEvidence = ""; }, (input: PricingInput) => { input.issues[0].note = ""; }, (input: PricingInput) => { input.issues[0].resolved = false; }, (input: PricingInput) => { input.terms = ""; }, (input: PricingInput) => { input.changes[0].oldItemNote = ""; }];
    for (const modify of changes) { const input = ready(q, d); modify(input); expect(previewPricing(q, d, input)).toMatchObject({ ready: false, proposedTotals: { totalCents: 85_600 } }); }
  });

  it("does not mistake explicitly reviewed zero tax/delivery/fee for missing values", () => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    input.changes[0].after!.taxCents = 0; input.changes[0].after!.freightCents = 0; input.changes[0].oldItemCostCents = 0;
    expect(previewPricing(q, d, input)).toMatchObject({ ready: true, proposedTotals: { totalCents: 83_000 } });
    input.changes[0].after!.taxCents = null;
    expect(previewPricing(q, d, input)).toMatchObject({ ready: false, proposedTotals: null, deltaTotalCents: null });
  });

  it.each([-1, 0.5, 2_000_000_001, Number.MAX_SAFE_INTEGER, NaN, Infinity])("rejects unsafe cents %s", (amount) => {
    const q = quote(); const d = draft(); const input = ready(q, d); input.changes[0].after!.taxCents = amount;
    expect(() => validatePricingInput(q, d, input)).toThrow(z.ZodError);
  });

  it.each([0, -1, 1.1, 10_001, Number.MAX_SAFE_INTEGER])("rejects invalid quantity %s", (quantity) => {
    const q = quote(); const d = draft(); const input = ready(q, d); input.changes[0].after!.quantity = quantity;
    expect(pricingInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects quantity-times-price and whole-quote overflow before preparing", () => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    input.changes[0].after!.unitPriceCents = 1_000_000_000;
    expect(previewPricing(q, d, input)).toMatchObject({ ready: false, proposedTotals: null, deltaTotalCents: null });
    input.changes[0].after!.quantity = 1; input.changes[0].after!.unitPriceCents = 1_999_999_000;
    expect(previewPricing(q, d, input).ready).toBe(false);
    expect(() => prepareChangeOrder(q, d, input, messages())).toThrow(PricingValidationError);
  });

  it("rejects an empty V2 but permits a real same-price replacement", () => {
    const q = quote(); const removeAll = draft([change("remove"), change("remove", "rug")]); const empty = ready(q, removeAll);
    empty.changes.forEach((entry) => { entry.oldItemCostCents = 0; });
    expect(previewPricing(q, removeAll, empty).problems.join()).toContain("至少需保留一行");
    const d = draft(); const input = ready(q, d);
    input.changes[0].after!.quantity = 2; input.changes[0].after!.unitPriceCents = 10_000; input.changes[0].after!.taxCents = 1_500; input.changes[0].after!.freightCents = 500; input.changes[0].oldItemCostCents = 0;
    expect(previewPricing(q, d, input)).toMatchObject({ ready: true, deltaTotalCents: 0 });
  });

  it("blocks a true no-op but recognizes a changed brand as business content", () => {
    const q = quote(); const d = draft([change("quantity")]); const input = ready(q, d);
    const old = q.lines[0]; Object.assign(input.changes[0].after!, item(old), { returnPolicy: old.returnPolicy, taxCents: old.taxCents, freightCents: old.freightCents, returnable: null, restockingFeeBps: null, customMade: false, leadTimeDays: old.leadTimeDays });
    expect(previewPricing(q, d, input).problems.join()).toContain("未修改任何报价内容");
    input.changes[0].after!.brand = "New confirmed brand";
    expect(previewPricing(q, d, input)).toMatchObject({ ready: true, deltaTotalCents: 0 });
  });

  it("allows unknown return eligibility/lead time when terms explicitly cover the uncertainty", () => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    input.changes[0].after!.returnable = null; input.changes[0].after!.leadTimeDays = null; input.changes[0].after!.restockingFeeBps = null;
    expect(previewPricing(q, d, input).ready).toBe(true);
  });

  it("freezes source pages, messages and baseline independently of later mutations", () => {
    const q = quote(); const d = draft(); const input = ready(q, d); const sourceMessages = messages();
    const body = prepareChangeOrder(q, d, input, sourceMessages);
    q.lines[0].name = "Mutated baseline"; d.sources[0].products[0].name = "Mutated page"; sourceMessages[0].text = "Edited later"; input.issues[0].note = "Edited later";
    expect(body.baselineLines[0].name).toBe("Original chair");
    expect(body.changes[0].before?.name).toBe("Original chair");
    expect(body.sources[0].products[0].name).toBe("New chair");
    expect(body.sourceMessages[0].text).toBe("Original text m1");
    expect(body.issues[0].note).not.toBe("Edited later");
  });

  it("refuses missing, duplicate or assistant source messages and stale drafts", () => {
    const q = quote(); const d = draft(); const input = ready(q, d);
    expect(() => prepareChangeOrder(q, d, input, [])).toThrow(PricingValidationError);
    expect(() => prepareChangeOrder(q, d, input, [...messages(), messages()[0]])).toThrow(PricingValidationError);
    const wrongActor = messages(); wrongActor[0].actor = "assistant";
    expect(() => prepareChangeOrder(q, d, input, wrongActor)).toThrow(PricingValidationError);
    d.basedOnVersion = 2;
    expect(() => validatePricingInput(q, d, input)).toThrow(PricingValidationError);
  });

  it("malformed or executable source URLs fail schema validation instead of throwing URL parser errors", () => {
    const input = ready(quote(), draft());
    for (const url of ["not a URL", "javascript:alert(1)", "https://user:pass@retailer.example.com/"]) {
      input.changes[0].after!.sourceUrl = url;
      expect(pricingInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("cannot turn a quantity adjustment into a replacement without handling the original product", () => {
    const q = quote(); const d = draft([change("quantity")]);
    for (const patch of [{ name: "Different chair" }, { vendor: "Another supplier" }, { sku: "ANOTHER-SKU" }, { specification: "Another selected variant" }, { category: "service" }, { unitLabel: "2-pack" }]) {
      const input = ready(q, d);
      Object.assign(input.changes[0].after!, patch);
      expect(() => validatePricingInput(q, d, input)).toThrow("数量变更不能换成另一商品");
      expect(previewPricing(q, d, input).ready).toBe(false);
    }
    const priced = ready(q, d);
    priced.changes[0].after!.unitPriceCents = 11_000;
    expect(previewPricing(q, d, priced).ready).toBe(true);
  });

  it("binds a review and a new AI draft to the full baseline even when its id/version stay the same", () => {
    const q = quote(); const d = draft();
    d.basedOnQuoteFingerprint = quoteFingerprint(q);
    const input = ready(q, d);
    q.lines[1].taxCents += 100;
    expect(() => createPricingInput(q, d)).toThrow("原批准报价内容已变化");
    expect(() => validatePricingInput(q, d, input)).toThrow("原批准报价内容已变化");
    const legacy = draft();
    delete legacy.basedOnQuoteFingerprint;
    expect(() => validatePricingInput(q, legacy, input)).toThrow("原批准报价内容已变化");
    const restored = quote();
    const touchedLegacy = draft();
    delete touchedLegacy.basedOnQuoteFingerprint;
    restored.lines[0].unitPriceCents += 1;
    expect(() => createPricingInput(restored, touchedLegacy)).toThrow("原物品与当前批准报价不一致");
  });

  it("uses a baseline tag stable across JSON object key ordering", () => {
    const q = quote();
    const reordered = Object.fromEntries(Object.entries(q).reverse()) as unknown as ApprovedQuoteReport;
    expect(quoteFingerprint(reordered)).toBe(quoteFingerprint(q));
    const repriced = structuredClone(q);
    repriced.lines[1].unitPriceCents += 1;
    expect(quoteFingerprint(repriced)).not.toBe(quoteFingerprint(q));
  });
});
