/** The fixed words for an old item's non-refundable costs, shared by the pricing page, the version, its receipt and the money answer. */
import type { NonRefundableFee, NonRefundableFeeKind, ReviewedChange } from "./types";

export const NON_REFUNDABLE_FEE_KINDS = ["restocking_fee", "fabrication_fee", "shipping", "material_cost", "cancellation_fee", "other"] as const satisfies readonly NonRefundableFeeKind[];

export const NON_REFUNDABLE_FEE_LABEL: Record<NonRefundableFeeKind, string> = {
  restocking_fee: "Restocking fee", fabrication_fee: "Fabrication fee", shipping: "Shipping", material_cost: "Material cost",
  cancellation_fee: "Cancellation fee", other: "Other cost",
};

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** "Fabrication fee $280.00"; several fees are joined with commas. */
export function feesText(fees: readonly NonRefundableFee[]): string {
  return fees.map((fee) => `${NON_REFUNDABLE_FEE_LABEL[fee.kind]} ${usd(fee.amountCents)}`).join(", ");
}

/** "Fabrication fee $280.00, not refunded": how a version and its receipt state an old item's non-refundable cost. */
export function notRefundedText(change: Pick<ReviewedChange, "oldItemCostCents" | "oldItemFees">): string {
  return change.oldItemCostCents > 0 ? `${nonRefundableText(change)}, not refunded` : "No non-refundable fee";
}

/**
 * What a frozen change keeps from the client, by type. A version frozen before
 * fees had types states only its total, which reads as "$280.00".
 */
export function nonRefundableText(change: Pick<ReviewedChange, "oldItemCostCents" | "oldItemFees">): string {
  return change.oldItemFees?.length ? feesText(change.oldItemFees) : usd(change.oldItemCostCents);
}
