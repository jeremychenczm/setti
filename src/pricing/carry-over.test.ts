import { describe, expect, it } from "vitest";
import { caseDocument } from "@/chat/cases";
import type { ChangeDraft, DraftChange } from "@/chat/types";
import { v1Change } from "@/opening/carry";
import { approvedForTest } from "@/opening/testing";
import { createPricingInput, validatePricingInput } from "./calculation";
import { carryOverReview } from "./carry-over";

const quote = approvedForTest("willow");
quote.lines = quote.lines.filter((line) => !["willow-office-chair", "willow-bulbs-e26"].includes(line.itemId));
const v1 = caseDocument("willow");
const chair = v1.lines.find((line) => line.itemId === "willow-office-chair")!;
const bulbs = v1.lines.find((line) => line.itemId === "willow-bulbs-e26")!;
const dining = quote.lines.find((line) => line.itemId === "willow-dining-chair")!;
const now = "2026-10-22T12:00:00.000Z";

function diningQuantity(quantity: number): DraftChange {
  const before = { name: dining.name, vendor: dining.vendor, brand: null, sku: dining.sku, specification: dining.specification, quantity: dining.quantity, unitLabel: dining.unitLabel ?? "each", unitPriceCents: dining.unitPriceCents, currency: "USD" };
  return { action: "quantity", itemId: dining.itemId, before, after: { ...before, quantity }, productOptionId: null, sourceMessageIds: [], beforeSubtotalCents: null, afterSubtotalCents: null, deltaSubtotalCents: null };
}

function draft(revision: number, changes: DraftChange[], unresolved: string[] = []): ChangeDraft {
  return {
    id: "draft-1", projectKey: "willow", basedOnQuoteId: quote.id, basedOnVersion: 1, revision, status: "needs_designer_review",
    title: "Revised lines from quote V1", summary: "", changes, sourceMessageIds: [], sources: [], unresolved, constraints: [], deltaSubtotalCents: null, createdAt: now, updatedAt: now, model: "designer",
  };
}

const first = draft(1, [v1Change(chair, "revised", "Too plain."), diningQuantity(6)], ["Check the delivery date"]);
const proposed = createPricingInput(quote, first);
function savedReview(edit: (input: ReturnType<typeof createPricingInput>) => void) {
  const input = structuredClone(proposed);
  input.title = "Willow V2 · study and dining";
  input.terms = "Prices hold for 14 days.";
  input.issues[0] = { ...input.issues[0], resolved: true, note: "Supplier confirmed Nov 3." };
  edit(input);
  return input;
}

describe("carrying a saved pricing review onto a newer draft", () => {
  it("drops an untouched internal placeholder while retaining a designer's actual verification", () => {
    const earlier = structuredClone(proposed);
    earlier.issues[0].note = "Suggested source for designer verification: local fictional HOME_SUPPLIER_NOTES";
    const saved = structuredClone(earlier);
    saved.issues[0].resolved = true;
    const latest = createPricingInput(quote, first);
    expect(carryOverReview(quote, earlier, saved, latest).input.issues[0]).toMatchObject({ resolved: false, note: "" });
    saved.issues[0].note += ". Supplier confirmed the delivery date.";
    expect(carryOverReview(quote, earlier, saved, latest).input.issues[0]).toMatchObject({ resolved: true, note: saved.issues[0].note });
  });
  it("keeps the designer's edits where the draft did not move, and takes the draft's updates where the designer did not edit", () => {
    const saved = savedReview((input) => {
      input.changes[0].after = { ...input.changes[0].after!, unitPriceCents: 8_888 };
      input.changes[0].confirmed = true;
    });
    const second = draft(2, [v1Change(chair, "revised", "Too plain."), diningQuantity(8), v1Change(bulbs, "carried", null)], ["Check the delivery date", "Confirm the bulb colour"]);
    const carried = carryOverReview(quote, proposed, saved, createPricingInput(quote, second));
    expect(carried).toMatchObject({ kept: ["Office chair"], updated: ["Dining chair"], added: ["LED bulb E26, 800 lumen"], removed: [], conflicts: [] });
    expect(carried.input.changes.map((change) => [change.key, change.after?.unitPriceCents ?? null, change.after?.quantity ?? null, change.confirmed])).toEqual([
      ["change-0", 8_888, chair.quantity, true],
      ["change-1", dining.unitPriceCents, 8, false],
      ["change-2", bulbs.unitPriceCents, bulbs.quantity, false],
    ]);
    expect(carried.input).toMatchObject({ title: "Willow V2 · study and dining", terms: "Prices hold for 14 days." });
    expect(carried.input.issues).toEqual([
      { id: "issue-0", label: "Check the delivery date", resolved: true, note: "Supplier confirmed Nov 3." },
      { id: "issue-1", label: "Confirm the bulb colour", resolved: false, note: "" },
    ]);
    expect(() => validatePricingInput(quote, second, carried.input)).not.toThrow();
  });

  it("merges field by field: the draft's new quantity and the designer's tax on the same line", () => {
    const saved = savedReview((input) => {
      input.changes[1].after = { ...input.changes[1].after!, taxCents: 1_234 };
      input.changes[1].confirmed = true;
    });
    const second = draft(2, [v1Change(chair, "revised", "Too plain."), diningQuantity(8)], ["Check the delivery date"]);
    const carried = carryOverReview(quote, proposed, saved, createPricingInput(quote, second));
    expect(carried).toMatchObject({ updated: ["Dining chair"], kept: [], conflicts: [] });
    expect(carried.input.changes[1]).toMatchObject({ after: { quantity: 8, taxCents: 1_234 }, confirmed: false });
  });

  it("leaves a field both sides changed for the designer, holding the designer's value until they choose", () => {
    const saved = savedReview((input) => { input.changes[1].after = { ...input.changes[1].after!, quantity: 7, taxCents: 1_234 }; });
    const second = draft(2, [v1Change(chair, "revised", "Too plain."), diningQuantity(8)], ["Check the delivery date"]);
    const carried = carryOverReview(quote, proposed, saved, createPricingInput(quote, second));
    expect(carried.updated).toEqual([]);
    expect(carried.conflicts).toHaveLength(1);
    const [conflict] = carried.conflicts;
    expect(conflict).toMatchObject({ key: "change-1", name: "Dining chair", changes: [{ label: "Quantity", before: "7", after: "8" }] });
    expect([conflict.mine.after?.quantity, conflict.latest.after?.quantity, conflict.latest.after?.taxCents]).toEqual([7, 8, 1_234]);
    expect(carried.input.changes[1]).toEqual(conflict.mine);
  });

  it("drops lines the newer draft no longer has, and takes the draft's title when the designer kept the original", () => {
    const saved = savedReview((input) => { input.title = proposed.title; });
    const second = { ...draft(2, [diningQuantity(6)]), title: "Dining chairs only" };
    const carried = carryOverReview(quote, proposed, saved, createPricingInput(quote, second));
    expect(carried).toMatchObject({ removed: ["Office chair"], kept: [], updated: [], added: [], conflicts: [] });
    expect(carried.input.title).toBe("Dining chairs only");
    expect(carried.input.changes.map((change) => change.key)).toEqual(["change-0"]);
  });
});
