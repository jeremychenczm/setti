/**
 * Refund promise for items that were already ordered from the vendor:
 * the client is refunded (captured amount minus the restocking fee) within
 * N business days after the vendor credit reaches the studio. The promise is
 * written into the revision the client approves, so both sides know the cost
 * and the wait before agreeing.
 */
import { assertCents } from "./limits";
import type { Cents } from "./types";

export const DEFAULT_REFUND_PROMISE_BUSINESS_DAYS = 5;

/** Adds business days (Mon-Fri, UTC). Public holidays are not modelled. */
export function addBusinessDays(start: Date, businessDays: number): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) {
    throw new RangeError(`businessDays must be a non-negative integer (got ${businessDays})`);
  }
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let remaining = businessDays;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

export interface RefundPromise {
  refundCents: Cents;
  retainedCents: Cents;
  dueDate: Date;
}

export function refundPromise(args: {
  capturedCents: Cents;
  restockingFeeCents: Cents;
  vendorCreditReceivedAt: Date;
  businessDays?: number;
}): RefundPromise {
  assertCents(args.capturedCents, "capturedCents");
  assertCents(args.restockingFeeCents, "restockingFeeCents");
  if (args.restockingFeeCents > args.capturedCents) {
    throw new RangeError("restocking fee cannot exceed the captured amount");
  }
  return {
    refundCents: args.capturedCents - args.restockingFeeCents,
    retainedCents: args.restockingFeeCents,
    dueDate: addBusinessDays(
      args.vendorCreditReceivedAt,
      args.businessDays ?? DEFAULT_REFUND_PROMISE_BUSINESS_DAYS,
    ),
  };
}
