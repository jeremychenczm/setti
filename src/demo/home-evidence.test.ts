import { describe, expect, it } from "vitest";
import { buildDraft } from "@/ai/draft";
import { modelContext } from "@/ai/model";
import type { AiOutput } from "@/ai/output";
import type { CaseMessage, ChangeDraft } from "@/chat/types";
import { changeSourceLabel, createPricingInput, draftSource, prepareChangeOrder, previewPricing } from "@/pricing/calculation";
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
    intent: "draft", message: "Proposed changes for Jordan's review.", title: "Window bay and back bar revision",
    // Deliberately out of baseline order: evidence must bind by item/product identity.
    changes: [
      { action: "replace", itemId: "wall-tile", quantity: 20, productOptionId: HOME_PRODUCT_IDS["wall-tile"], description: "Sage green tile on the back bar and side wall", sourceMessageIds: ["discussion-13"] },
      { action: "add", itemId: null, quantity: 16, productOptionId: HOME_PRODUCT_IDS.windowCounter, description: "Oak window counter", sourceMessageIds: ["discussion-1"] },
      { action: "quantity", itemId: "stools", quantity: 14, productOptionId: null, description: "", sourceMessageIds: ["discussion-2"] },
      { action: "add", itemId: null, quantity: 12, productOptionId: HOME_PRODUCT_IDS.panels, description: "Acoustic panels", sourceMessageIds: ["discussion-5"] },
      { action: "quantity", itemId: "countertop", quantity: 18, productOptionId: null, description: "Front counter re-cut to 10 ft", sourceMessageIds: ["discussion-7"] },
      { action: "quantity", itemId: "pendants", quantity: 4, productOptionId: null, description: "", sourceMessageIds: ["discussion-9"] },
      { action: "quantity", itemId: "site-visits", quantity: 6, productOptionId: null, description: "", sourceMessageIds: ["discussion-16"] },
    ], unresolved: [], constraints: ["Keep the design fee and the back bar top unchanged."],
  };
}
function makeDraft(): ChangeDraft {
  return buildDraft({ quote: HOME_APPROVED_QUOTE, output: homeOutput(), messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "actual-configured-model", now: at }).draft!;
}

describe("local supplier evidence for the café proposal", () => {
  it("preselects walkthrough checks without rewriting AI issues or confirming a different project's review", () => {
    const draft = makeDraft();
    draft.unresolved = ["Check the window counter brackets on site", "Confirm the tile supplier's return approval"];
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
    expect(HOME_DESIGNER_REQUEST).not.toMatch(/17,506|DEMO-CAFE-|tile\s*→/);
    expect(pages[0].url).toMatch(/^local:/);
  });

  it("calculates seven changes, retains the exact sources and identifies the designer as author of a client-conversation change", () => {
    const draft = makeDraft();
    expect(draft.changes).toHaveLength(7);
    expect(draft.deltaSubtotalCents).toBe(597_000); // Goods/service subtotal before the separate re-cut and restocking costs.
    expect(draft.origin).toBe("designer");
    expect(draftSource(draft).kind).toBe("client");
    expect(draft.sources[0].text).toBe(HOME_SUPPLIER_NOTES);
    expect(draft.changes.find((change) => change.itemId === "wall-tile")?.after).toMatchObject({ quantity: 20, unitPriceCents: 7_600, sku: "DEMO-CAFE-TILE-SGE-4", unitLabel: "box" });
    expect(draft.changes.find((change) => change.action === "add" && change.productOptionId === HOME_PRODUCT_IDS.windowCounter)?.after).toMatchObject({ quantity: 16, unitPriceCents: 21_000, unitLabel: "linear ft" });
    expect(draft.changes.find((change) => change.itemId === "countertop")?.after).toMatchObject({ quantity: 18, unitPriceCents: 18_000 });
  });

  it("prepopulates an accurate $17,506 / +$6,446 proposal while every human check remains open", () => {
    const draft = makeDraft();
    const input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    expect(input.changes.every((change) => !change.confirmed)).toBe(true);
    expect(input.issues).toEqual([]);
    expect(input.changes.filter((change) => change.after).every((change) => change.after!.taxCents === 0 && change.after!.freightCents === 0 && change.after!.sourceUrl === null)).toBe(true);
    expect(input.changes.find((change) => change.itemId === "countertop")).toMatchObject({ oldItemHandling: "cancelled", oldItemCostCents: 28_000, oldItemNote: expect.stringContaining("refund of USD 440 waits for that credit") });
    expect(input.changes.find((change) => change.itemId === "wall-tile")).toMatchObject({ oldItemHandling: "returned", oldItemCostCents: 19_600, oldItemNote: expect.stringContaining("credits USD 784") });
    expect(input.changes.find((change) => change.itemId === "pendants")).toMatchObject({ oldItemHandling: "not_ordered", oldItemCostCents: 0 });
    expect(input.changes.filter((change) => change.action === "add").map((change) => change.after)).toEqual([
      expect.objectContaining({ category: "furniture", customMade: true, returnable: false, leadTimeDays: 21 }),
      expect.objectContaining({ category: "furniture", customMade: false, returnable: true, restockingFeeBps: 1_000 }),
    ]);
    expect(input.changes.find((change) => change.itemId === "site-visits")?.after).toMatchObject({ category: "service", quantity: 6, unitPriceCents: 18_000 });
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input)).toMatchObject({ ready: false, baselineTotals: { totalCents: 1_106_000 }, proposedTotals: { totalCents: 1_750_600 }, deltaTotalCents: 644_600 });
    expect(() => prepareChangeOrder(HOME_APPROVED_QUOTE, draft, input, homeMessages())).toThrow();
  });

  it("freezes reviewed sources and retained costs only after explicit designer checks, preserving the unchanged design fee", () => {
    const original = JSON.stringify(HOME_APPROVED_QUOTE);
    const draft = makeDraft(), input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues.forEach((issue) => { issue.resolved = true; });
    const body = prepareChangeOrder(HOME_APPROVED_QUOTE, draft, input, homeMessages());
    expect(body.totals.totalCents).toBe(1_750_600);
    expect(body.deltaTotalCents).toBe(644_600);
    expect(body.source?.kind).toBe("client");
    expect(body.lines.find((line) => line.itemId === "design")).toMatchObject({ origin: "unchanged", unitPriceCents: 240_000 });
    expect(body.lines.filter((line) => line.origin === "old_item_cost").map((line) => line.unitPriceCents).sort((a, b) => a - b)).toEqual([19_600, 28_000]);
    expect(body.sources[0].text).toBe(HOME_SUPPLIER_NOTES);
    expect(body).not.toHaveProperty("payment");
    expect(JSON.stringify(HOME_APPROVED_QUOTE)).toBe(original);
  });

  it("rejects a supplier option attached to the wrong original item", () => {
    const output = homeOutput();
    output.changes.find((change) => change.itemId === "wall-tile")!.productOptionId = HOME_PRODUCT_IDS.windowCounter;
    expect(() => buildDraft({ quote: HOME_APPROVED_QUOTE, output, messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "test" })).toThrow("different original item");
  });

  it("retains a genuine model question without filling in an internal source instruction", () => {
    const output = homeOutput();
    output.unresolved = ["Confirm the window counter brackets against the measured wall."];
    const draft = buildDraft({ quote: HOME_APPROVED_QUOTE, output, messages: homeMessages(), pages: [HOME_EVIDENCE_PAGE(at)], current: null, triggerId: "request", model: "test" }).draft!;
    const input = createPricingInput(HOME_APPROVED_QUOTE, draft);
    expect(input.issues).toHaveLength(1);
    expect(input.issues[0]).toMatchObject({ label: output.unresolved[0], resolved: false, note: "" });
    input.changes.forEach((change) => { change.confirmed = true; });
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(false);
    input.issues[0].resolved = true;
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(true);
    input.issues[0].note = "Bracket positions checked against the measured wall.";
    expect(previewPricing(HOME_APPROVED_QUOTE, draft, input).ready).toBe(true);
  });

  it("does not fabricate terms when the local source, original SKU or original costs no longer match", () => {
    const draft = makeDraft();
    const tile = draft.changes.find((change) => change.itemId === "wall-tile")!;
    expect(homePricingEvidence(HOME_APPROVED_QUOTE, tile, [])).toBeNull();
    for (const patch of [{ sku: "A-DIFFERENT-TILE" }, { unitPriceCents: 7_500 }, { taxCents: 100 }]) {
      const quote = structuredClone(HOME_APPROVED_QUOTE);
      Object.assign(quote.lines.find((line) => line.itemId === "wall-tile")!, patch);
      expect(homePricingEvidence(quote, tile, draft.sources)).toBeNull();
    }
    draft.sources = [];
    expect(createPricingInput(HOME_APPROVED_QUOTE, draft).changes.find((change) => change.itemId === "wall-tile")?.oldItemCostCents).toBeNull();
  });

  it("retains profile detection after a line is removed without treating the legacy chair/rug project as home", () => {
    expect(isHomeQuote({ projectId: "maple", lines: HOME_APPROVED_QUOTE.lines.filter((line) => line.itemId !== "wall-tile") })).toBe(true);
    expect(isHomeQuote({ projectId: "maple", lines: HOME_APPROVED_QUOTE.lines.map((line) => ({ ...line, itemId: `legacy-${line.itemId}` })) })).toBe(false);
  });

  it("treats every change as the client conversation unless a supplier's notice started it", () => {
    expect(draftSource({}).kind).toBe("client");
    expect(draftSource({ supplierNotice: { vendor: "Quillmark Office", notice: "Desk is $129.99." } })).toEqual({ kind: "vendor", vendor: "Quillmark Office", notice: "Desk is $129.99." });
    // Versions frozen before the merge still say "designer" and read the same as the client conversation.
    expect((["client", "designer", "vendor"] as const).map((kind) => changeSourceLabel({ kind }))).toEqual(["Client conversation", "Client conversation", "Supplier notice"]);
  });
});
