import type { FrozenChangeOrder } from "../pricing/types";
import type { LineRef } from "./binding";

export interface ConfirmedSupplierTerms {
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
  freightCents: number;
  purpose: "order" | "retained_cost";
}

/** The frozen terms a supplier confirms for one funding line, including an old item's retained cost. */
export function confirmedSupplierTerms(order: FrozenChangeOrder, input: LineRef): ConfirmedSupplierTerms | null {
  const change = order.changes.find((entry) => entry.itemId === input.itemId);
  if (input.side === "baseline" && change && (change.action === "remove" || change.action === "replace")) {
    const fee = order.lines.find((line) => line.itemId === `old-cost-${order.sourceDraftId}-${change.key}`);
    if (change.oldItemCostCents <= 0 || !fee || fee.origin !== "old_item_cost"
        || fee.quantity !== 1 || fee.unitPriceCents !== change.oldItemCostCents || fee.taxCents !== 0 || fee.freightCents !== 0) return null;
    return { quantity: 1, unitPriceCents: fee.unitPriceCents, taxCents: 0, freightCents: 0, purpose: "retained_cost" };
  }
  const line = order.lines.find((entry) => entry.itemId === input.itemId);
  return line ? { quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents, purpose: "order" } : null;
}
