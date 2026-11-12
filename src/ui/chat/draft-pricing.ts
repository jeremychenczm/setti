import type { ChangeDraft } from "@/chat/types";
import { isHomeQuote } from "@/demo/home-evidence";
import { createPricingInput, previewPricing } from "@/pricing/calculation";
import { NON_REFUNDABLE_FEE_LABEL } from "@/pricing/fees";
import type { PricingWorkspace } from "@/pricing/types";

/** What the draft does to the total before pricing, and the non-refundable fees of the items it changes. */
export interface DraftEstimate {
  baseline: number;
  total: number;
  difference: number;
  /** One per fee, on the quote line it comes from ("Fabrication fee" on the countertop). */
  fees: { itemId: string | null; name: string; label: string; cents: number }[];
}

/**
 * The estimate Setti can work out for a draft from the sample supplier terms: the
 * same calculation the pricing page starts from. Null when the quote has no such
 * terms or the workspace holds another draft.
 */
export function draftEstimate(workspace: PricingWorkspace, draft: Pick<ChangeDraft, "id" | "revision">): DraftEstimate | null {
  if (!isHomeQuote(workspace.quote) || workspace.sourceDraft?.id !== draft.id || workspace.sourceDraft.revision !== draft.revision) return null;
  const proposed = createPricingInput(workspace.quote, workspace.sourceDraft);
  const preview = previewPricing(workspace.quote, workspace.sourceDraft, proposed);
  if (!preview.proposedTotals || preview.deltaTotalCents === null) return null;
  const nameOf = (itemId: string | null) => workspace.quote.lines.find((line) => line.itemId === itemId)?.name ?? "Old item";
  const fees = proposed.changes.flatMap((change) => {
    const total = change.oldItemCostCents ?? 0;
    if (total <= 0) return [];
    const typed = change.oldItemFees.filter((fee): fee is { kind: typeof fee.kind; amountCents: number } => fee.amountCents !== null && fee.amountCents > 0);
    return typed.length
      ? typed.map((fee) => ({ itemId: change.itemId, name: nameOf(change.itemId), label: NON_REFUNDABLE_FEE_LABEL[fee.kind], cents: fee.amountCents }))
      : [{ itemId: change.itemId, name: nameOf(change.itemId), label: "Non-refundable cost", cents: total }];
  });
  return { baseline: preview.baselineTotals.totalCents, total: preview.proposedTotals.totalCents, difference: preview.deltaTotalCents, fees };
}
