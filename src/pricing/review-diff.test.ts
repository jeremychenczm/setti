import { describe, expect, it } from "vitest";
import { caseDocument } from "@/chat/cases";
import type { ChangeDraft } from "@/chat/types";
import { v1Change } from "@/opening/carry";
import { approvedForTest } from "@/opening/testing";
import { createPricingInput, previewPricing } from "./calculation";
import { reviewSummary } from "./review-diff";
import type { PricingWorkspace } from "./types";

const quote = approvedForTest("willow");
quote.lines = quote.lines.filter((line) => !["willow-office-chair", "willow-bulbs-e26"].includes(line.itemId));
const v1 = caseDocument("willow");
const chair = v1.lines.find((line) => line.itemId === "willow-office-chair")!;
const bulbs = v1.lines.find((line) => line.itemId === "willow-bulbs-e26")!;
const now = "2026-10-22T12:00:00.000Z";
const draft: ChangeDraft = {
  id: "draft-1", projectKey: "willow", basedOnQuoteId: quote.id, basedOnVersion: 1, revision: 2, status: "needs_designer_review",
  title: "Revised lines from quote V1", summary: "", changes: [v1Change(chair, "revised", "Too plain."), v1Change(bulbs, "carried", null)],
  sourceMessageIds: [], sources: [], unresolved: [], constraints: [], deltaSubtotalCents: null, createdAt: now, updatedAt: now, model: "designer",
};

function workspace(edit: (input: ReturnType<typeof createPricingInput>) => void, revision = 2): PricingWorkspace {
  const input = createPricingInput(quote, draft);
  edit(input);
  const review = { id: "review-1", sourceDraftId: draft.id, sourceDraftRevision: revision, version: 2, input, createdAt: now, updatedAt: now };
  return { caseId: "case-1", projectKey: "willow", quote, sourceDraft: draft, review, preview: previewPricing(quote, draft, input), stale: false, orders: [] };
}

describe("saved pricing review summary", () => {
  it("lists only the fields the designer changed, against each line as it was in V1", () => {
    const summary = reviewSummary(workspace((input) => {
      input.changes[0].after = { ...input.changes[0].after!, name: "Office luxury chair", unitPriceCents: 8_888 };
      input.changes[0].confirmed = true;
      input.changes[1].after = { ...input.changes[1].after!, unitPriceCents: 399 };
    }))!;
    expect(summary).toMatchObject({ version: 2, stale: false, confirmed: 1 });
    expect(summary.lines.map((line) => [line.name, line.kind, line.confirmed])).toEqual([["Office luxury chair", "revised", true], ["LED bulb E26, 800 lumen", "carried", false]]);
    expect(summary.lines[0].changes).toEqual([
      { label: "Name", before: "Office chair", after: "Office luxury chair" },
      { label: "Unit price", before: "$99.99", after: "$88.88" },
    ]);
    expect(summary.lines[1].changes).toEqual([{ label: "Unit price", before: "$4.99", after: "$3.99" }]);
    expect(summary.lines[0].fromV1).toEqual({ itemId: "willow-office-chair", kind: "revised", reason: "Too plain." });
  });

  it("reports an untouched line as unchanged, and nothing for a review saved against an older draft", () => {
    expect(reviewSummary(workspace(() => {}))!.lines.every((line) => line.changes.length === 0)).toBe(true);
    const stale = reviewSummary(workspace(() => {}, 1))!;
    expect(stale.stale).toBe(true);
    expect(stale.lines).toEqual([]);
  });

  it("has no summary before a review is saved", () => {
    const unsaved = workspace(() => {});
    expect(reviewSummary({ ...unsaved, review: { ...unsaved.review!, version: 0 } })).toBeNull();
    expect(reviewSummary({ ...unsaved, review: null })).toBeNull();
  });

  it("keeps an edited carried line from claiming it is unchanged", () => {
    const edited = workspace((input) => { input.changes[1].after = { ...input.changes[1].after!, unitPriceCents: 399 }; });
    const stale = previewPricing(quote, draft, edited.review!.input).problems;
    expect(stale).toContain("LED bulb E26, 800 lumen: this line no longer matches quote V1 (unit price). Update the price evidence to say what changed.");
    const updated = structuredClone(edited.review!.input);
    updated.changes[1].priceEvidence = "Larkspur Lighting confirmed $3.99 per 2-pack on Oct 22.";
    expect(previewPricing(quote, draft, updated).problems.some((problem) => problem.includes("no longer matches quote V1"))).toBe(false);
    expect(previewPricing(quote, draft, workspace(() => {}).review!.input).problems.some((problem) => problem.includes("no longer matches quote V1"))).toBe(false);
  });
});
