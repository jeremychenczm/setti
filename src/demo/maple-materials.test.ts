import { describe, expect, it } from "vitest";
import { buildDraft } from "@/ai/draft";
import type { CaseMessage } from "@/chat/types";
import { createPricingInput, previewPricing } from "@/pricing/calculation";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { canLoadMapleSampleMaterials, isMapleSampleScope, loadMapleSampleMaterials, MAPLE_MIXED_CHANGE_MESSAGE, MAPLE_SAMPLE_MATERIALS } from "./maple-materials";

function fixture(name = "Oak writing table") {
  const quote = structuredClone(mapleApprovedQuote);
  const message: CaseMessage = { id: "maple-request", actor: "client", text: MAPLE_MIXED_CHANGE_MESSAGE, createdAt: "2026-10-24T12:00:00Z",
    replyToMessageId: null, aiState: "none", error: null, model: null };
  // Unit input for the normal draft builder; the walkthrough's UI sends a real model request.
  const draft = buildDraft({ quote, messages: [message], pages: [], current: null, triggerId: message.id, model: "unit-input",
    output: { intent: "draft", title: "Chair replacement and rug return", message: "Draft for review.", constraints: [], unresolved: [],
      changes: [
        { action: "replace", itemId: "chair", quantity: 1, productOptionId: null, description: name, sourceMessageIds: [message.id] },
        { action: "remove", itemId: "rug", quantity: null, productOptionId: null, description: "", sourceMessageIds: [message.id] },
      ] } }).draft!;
  return { quote, draft, input: createPricingInput(quote, draft) };
}

describe("Maple walkthrough supplier materials", () => {
  it("fills the fictional source details while leaving every human check and original input intact", () => {
    const { quote, draft, input } = fixture();
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues[0].note = "A designer's existing note.";
    const before = structuredClone({ quote, draft, input });
    const filled = loadMapleSampleMaterials(quote, input)!;
    expect(filled.baselineFingerprint).toBe(input.baselineFingerprint);
    expect(filled.changes.map((change) => [change.itemId, change.action, change.confirmed, change.oldItemHandling, change.oldItemCostCents])).toEqual([
      ["chair", "replace", false, "not_ordered", 0], ["rug", "remove", false, "returned", 6_000],
    ]);
    expect(filled.changes[0].after).toMatchObject({ sku: MAPLE_SAMPLE_MATERIALS.desk.sku, unitPriceCents: 110_000, currency: "USD", unitLabel: "each", quantity: 1,
      taxCents: 0, freightCents: 0, sourceUrl: null, leadTimeDays: 14 });
    expect(filled.changes[0].priceEvidence).toContain("Fictional sample supplier quote MAPLE-SAMPLE-Q1");
    expect(filled.issues).toEqual(input.issues);
    expect({ quote, draft, input }).toEqual(before);
    const preview = previewPricing(quote, draft, filled);
    expect(preview).toMatchObject({ ready: false, deltaTotalCents: 6_000, proposedTotals: { totalCents: 156_000 } });
    expect(preview.problems).toContain("Light oak writing desk: the designer has not confirmed this line's pricing.");
    // The supplied details become issuable only after the designer checks both changes and open items.
    filled.changes.forEach((change) => { change.confirmed = true; });
    filled.issues.forEach((issue) => { issue.resolved = true; issue.note = "Checked against the displayed fictional supplier materials."; });
    expect(previewPricing(quote, draft, filled).ready).toBe(true);
  });

  it("accepts a model's desk wording but refuses another product, quantity or change set", () => {
    for (const name of ["Light oak desk", "Oak writing table"]) {
      const { quote, input } = fixture(name);
      expect(canLoadMapleSampleMaterials(quote, input)).toBe(true);
    }
    const { quote, input } = fixture("Walnut sofa");
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
    input.changes[0].after!.name = "Writing desk";
    input.changes[0].after!.quantity = 2;
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
    input.changes[0].after!.quantity = 1;
    input.changes.pop();
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
  });

  it("never loads over another project's quote, a changed baseline or an externally sourced desk", () => {
    const { quote, input } = fixture();
    expect(isMapleSampleScope(quote)).toBe(true);
    quote.projectId = "willow";
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
    quote.projectId = "maple";
    quote.lines.find((line) => line.itemId === "chair")!.taxCents = 1;
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
    quote.lines.find((line) => line.itemId === "chair")!.taxCents = 0;
    input.changes[0].after!.sourceUrl = "https://supplier.invalid/test-source";
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
    input.changes[0].after!.sourceUrl = null;
    input.changes[0].after!.unitPriceCents = 120_000;
    expect(loadMapleSampleMaterials(quote, input)).toBeNull();
  });

  it("keeps the designer's existing terms, review notes and unresolved questions", () => {
    const { quote, input } = fixture();
    input.terms = "Designer-entered terms to retain.";
    input.reviewNotes = "Designer-entered review notes.";
    const filled = loadMapleSampleMaterials(quote, input)!;
    expect(filled).toMatchObject({ terms: input.terms, reviewNotes: input.reviewNotes, issues: input.issues });
    expect(filled.changes.every((change) => !change.confirmed)).toBe(true);
  });
});
