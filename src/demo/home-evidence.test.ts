import { describe, expect, it } from "vitest";
import { buildDraft } from "@/ai/draft";
import { modelContext } from "@/ai/model";
import type { AiOutput } from "@/ai/output";
import type { CaseMessage, ChangeDraft } from "@/chat/types";
import { createPricingInput, draftSource, prepareChangeOrder, previewPricing } from "@/pricing/calculation";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_SUPPLIER_NOTES } from "./living-dining";
import { HOME_EVIDENCE_PAGE, HOME_PRODUCT_IDS, homePricingEvidence, isHomeQuote } from "./home-evidence";
import { createReviewInput } from "@/ui/pricing/demo-review";

const at = "2026-10-29T12:00:00Z";
export function homeMessages(): CaseMessage[] {
  return [...HOME_DISCUSSION, { actor: "designer" as const, text: HOME_DESIGNER_REQUEST }].map((entry, index) => ({
    ...entry, id: index === HOME_DISCUSSION.length ? "request" : `discussion-${index}`,
    createdAt: at, replyToMessageId: null, aiState: "none", error: null, model: null,
  }));
}
export function homeOutput(): AiOutput {
  return {
    intent: "draft", message: "Proposed changes for Jordan's review.", title: "Living and dining revision",
    // Deliberately out of baseline order: evidence must bind by item/product identity.
    changes: [
      { action: "remove", itemId: "sideboard", quantity: null, productOptionId: null, description: "", sourceMessageIds: ["discussion-0"] },
      { action: "replace", itemId: "coffee-table", quantity: 2, productOptionId: HOME_PRODUCT_IDS["coffee-table"], description: "Two side tables", sourceMessageIds: ["discussion-1"] },
      { action: "quantity", itemId: "dining-chairs", quantity: 4, productOptionId: null, description: "", sourceMessageIds: ["discussion-2"] },
      { action: "replace", itemId: "sofa", quantity: 1, productOptionId: HOME_PRODUCT_IDS.sofa, description: "Compact sofa", sourceMessageIds: ["discussion-3"] },
      { action: "replace", itemId: "dining-table", quantity: 1, productOptionId: HOME_PRODUCT_IDS["dining-table"], description: "Round table", sourceMessageIds: ["discussion-4"] },
    ], unresolved: [], constraints: ["Keep the design-service scope and fee unchanged."],
  };
}
function makeDraft(): ChangeDraft {
  return buildDraft({ quote: HOME_APPROVED_QUOTE, output: homeOutput(), messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "actual-configured-model", now: at }).draft!;
}

describe("local supplier evidence for the living-and-dining proposal", () => {
  it("preselects walkthrough checks without rewriting AI issues or confirming a different project's review", () => {
    const draft = makeDraft();
    draft.unresolved = ["Check measured chair clearance", "Confirm supplier return approval"];
    const original = JSON.stringify(draft);
    const input = createReviewInput(HOME_APPROVED_QUOTE, draft);
    expect(input.changes.every((change) => change.confirmed)).toBe(true);
    expect(input.issues).toEqual(draft.unresolved.map((label, index) => ({ id: `issue-${index}`, label, resolved: true, note: "" })));
    expect(input.reviewNotes).toContain("Demo walkthrough");
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(true);
    expect(JSON.stringify(draft)).toBe(original);
    const otherQuote = { ...HOME_APPROVED_QUOTE, projectId: "willow" };
    const other = createReviewInput(otherQuote, { ...draft, projectKey: "willow", basedOnQuoteFingerprint: undefined });
    expect(other.changes.every((change) => !change.confirmed)).toBe(true);
    expect(other.issues.every((issue) => !issue.resolved)).toBe(true);
  });
  it("supplies fictional documents and exact options to the real model interface without putting answers in the trigger", () => {
    const pages = [HOME_EVIDENCE_PAGE(at)];
    const context = JSON.parse(modelContext({ quote: HOME_APPROVED_QUOTE, messages: homeMessages(), current: null, pages, triggerId: "request" }));
    expect(context.messages).toHaveLength(HOME_DISCUSSION.length + 1);
    expect(context.productPages[0].text).toBe(HOME_SUPPLIER_NOTES);
    expect(context.productPages[0].products.map((product: { id: string }) => product.id)).toEqual(Object.values(HOME_PRODUCT_IDS));
    expect(HOME_DESIGNER_REQUEST).not.toMatch(/2,100|5,670|DEMO-LD-|sofa\s*→/);
    expect(pages[0].url).toMatch(/^local:/);
  });

  it("calculates five changes, retains the exact sources and identifies the designer as proposal origin", () => {
    const draft = makeDraft();
    expect(draft.changes).toHaveLength(5);
    expect(draft.deltaSubtotalCents).toBe(-230_000); // Goods/service subtotal before the separate retained return cost.
    expect(draft.origin).toBe("designer");
    expect(draftSource(draft).kind).toBe("designer");
    expect(draft.sources[0].text).toBe(HOME_SUPPLIER_NOTES);
    expect(draft.changes.find((change) => change.itemId === "coffee-table")?.after).toMatchObject({ quantity: 2, unitPriceCents: 18_000, sku: "DEMO-LD-SIDE-40" });
    expect(draft.changes.find((change) => change.itemId === "dining-table")?.after?.specification).toContain("110 cm");
  });

  it("prepopulates an accurate $5,670 / -$2,060 proposal while every human check remains open", () => {
    const draft = makeDraft();
    const input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    expect(input.changes.every((change) => !change.confirmed)).toBe(true);
    expect(input.issues).toEqual([]);
    expect(input.changes.filter((change) => change.after).every((change) => change.after!.taxCents === 0 && change.after!.freightCents === 0 && change.after!.sourceUrl === null)).toBe(true);
    expect(input.changes.find((change) => change.itemId === "sideboard")).toMatchObject({ oldItemHandling: "returned", oldItemCostCents: 24_000, oldItemNote: expect.stringContaining("waits for supplier credit") });
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input)).toMatchObject({ ready: false, baselineTotals: { totalCents: 773_000 }, proposedTotals: { totalCents: 567_000 }, deltaTotalCents: -206_000 });
    expect(() => prepareChangeOrder(HOME_APPROVED_QUOTE, draft, input, homeMessages())).toThrow();
  });

  it("freezes reviewed sources and retained cost only after explicit designer checks, preserving the unchanged services", () => {
    const original = JSON.stringify(HOME_APPROVED_QUOTE);
    const draft = makeDraft(), input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues.forEach((issue) => { issue.resolved = true; });
    const body = prepareChangeOrder(HOME_APPROVED_QUOTE, draft, input, homeMessages());
    expect(body.totals.totalCents).toBe(567_000);
    expect(body.deltaTotalCents).toBe(-206_000);
    expect(body.source?.kind).toBe("designer");
    expect(body.lines.find((line) => line.itemId === "design")).toMatchObject({ origin: "unchanged", unitPriceCents: 100_000 });
    expect(body.lines.find((line) => line.origin === "old_item_cost")?.unitPriceCents).toBe(24_000);
    expect(body.sources[0].text).toBe(HOME_SUPPLIER_NOTES);
    expect(body).not.toHaveProperty("payment");
    expect(JSON.stringify(HOME_APPROVED_QUOTE)).toBe(original);
  });

  it("rejects a supplier option attached to the wrong original item", () => {
    const output = homeOutput();
    output.changes.find((change) => change.itemId === "sofa")!.productOptionId = HOME_PRODUCT_IDS["dining-table"];
    expect(() => buildDraft({ quote: HOME_APPROVED_QUOTE, output, messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "test" })).toThrow("different original item");
  });

  it("retains a genuine model question without filling in an internal source instruction", () => {
    const output = homeOutput();
    output.unresolved = ["Confirm the round table and chair clearances against the measured layout."];
    const draft = buildDraft({ quote: HOME_APPROVED_QUOTE, output, messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "test" }).draft!;
    const input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    expect(input.issues).toHaveLength(1);
    expect(input.issues[0]).toMatchObject({ label: output.unresolved[0], resolved: false, note: "" });
    input.changes.forEach((change) => { change.confirmed = true; });
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(false);
    input.issues[0].resolved = true;
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(true);
    input.issues[0].note = "Position and chair clearances checked against the measured layout.";
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(true);
  });

  it("does not fabricate terms when the local source, original SKU or original costs no longer match", () => {
    const draft = makeDraft();
    const sideboard = draft.changes.find((change) => change.itemId === "sideboard")!;
    expect(homePricingEvidence(HOME_APPROVED_QUOTE, sideboard, [])).toBeNull();
    for (const patch of [{ sku: "A-DIFFERENT-SIDEBOARD" }, { unitPriceCents: 125_000 }, { taxCents: 100 }]) {
      const quote = structuredClone(HOME_APPROVED_QUOTE);
      Object.assign(quote.lines.find((line) => line.itemId === "sideboard")!, patch);
      expect(homePricingEvidence(quote, sideboard, draft.sources)).toBeNull();
    }
    draft.sources = [];
    expect(createPricingInput(HOME_APPROVED_QUOTE, draft).changes.find((change) => change.itemId === "sideboard")?.oldItemCostCents).toBeNull();
  });

  it("retains profile detection after sideboard removal without treating the legacy chair/rug project as home", () => {
    expect(isHomeQuote({ projectId: "maple", lines: HOME_APPROVED_QUOTE.lines.filter((line) => line.itemId !== "sideboard") })).toBe(true);
    expect(isHomeQuote({ projectId: "maple", lines: HOME_APPROVED_QUOTE.lines.map((line) => ({ ...line, itemId: `legacy-${line.itemId}` })) })).toBe(false);
    expect(draftSource({ model: "designer" }).kind).toBe("designer");
    expect(draftSource({ model: "legacy-ai" }).kind).toBe("client");
  });
});
