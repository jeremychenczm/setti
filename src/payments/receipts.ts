/**
 * One place that decides what a PayPal receipt means for the money. A receipt
 * proves a money move only when it names the resource, states a status Setti
 * recognises, and reports the exact amount and currency that were asked for.
 * Anything less is incomplete (read the resource again) or a mismatch (stop and
 * let a person reconcile); it is never treated as done.
 */
import type { AuthorizationReceipt, CaptureReceipt, RefundReceipt } from "./paypal";

/** PayPal's decimal string ("543.75") as exact cents; anything else is undefined. */
export function parseCents(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Exact cents as PayPal's decimal string. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`Invalid cent amount ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** What a capture status means for the money. Refunded captures still took the money first. */
export function captureMoneyStatus(status: string | undefined): "completed" | "pending" | "declined" | undefined {
  switch (status) {
    case "COMPLETED":
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "completed";
    case "PENDING":
      return "pending";
    case "DECLINED":
    case "FAILED":
      return "declined";
    default:
      return undefined;
  }
}

export function refundMoneyStatus(status: string | undefined): "completed" | "pending" | "failed" | undefined {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "PENDING":
      return "pending";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return undefined;
  }
}

/** What an authorization status means for the hold. `pending` and `denied` are not usable holds. */
export function holdStatus(status: string | undefined): "created" | "partially_captured" | "captured" | "voided" | "pending" | "denied" | undefined {
  switch (status) {
    case "CREATED":
      return "created";
    case "PARTIALLY_CAPTURED":
      return "partially_captured";
    case "CAPTURED":
      return "captured";
    case "VOIDED":
      return "voided";
    case "PENDING":
      return "pending";
    case "DENIED":
      return "denied";
    default:
      return undefined;
  }
}

export type Verified<T> = { ok: true; value: T } | { ok: false; code: "RECEIPT_INCOMPLETE" | "RECEIPT_MISMATCH"; message: string };

const incomplete = (message: string) => ({ ok: false, code: "RECEIPT_INCOMPLETE", message }) as const;
const mismatch = (message: string) => ({ ok: false, code: "RECEIPT_MISMATCH", message }) as const;

function checkMoney(receipt: { amountCents?: number; currency?: string }, expectedCents: number, what: string): Verified<null> {
  if (receipt.amountCents === undefined || receipt.currency === undefined) return incomplete(`PayPal did not report the ${what} amount and currency.`);
  if (receipt.currency !== "USD") return mismatch(`PayPal reported the ${what} in ${receipt.currency}, not USD.`);
  if (receipt.amountCents !== expectedCents) return mismatch(`PayPal reported a ${what} of ${formatCents(receipt.amountCents)} USD; Setti asked for ${formatCents(expectedCents)} USD.`);
  return { ok: true, value: null };
}

export function verifyCapture(receipt: CaptureReceipt, expectedCents: number): Verified<{ paypalCaptureId: string; status: "completed" | "pending" | "declined"; amountCents: number }> {
  if (!receipt.paypalCaptureId) return incomplete("PayPal did not return a capture id.");
  const status = captureMoneyStatus(receipt.status);
  if (!status) return incomplete(`PayPal did not return a recognised capture status (${receipt.status ?? "none"}).`);
  const money = checkMoney(receipt, expectedCents, "capture");
  if (!money.ok) return money;
  return { ok: true, value: { paypalCaptureId: receipt.paypalCaptureId, status, amountCents: expectedCents } };
}

export function verifyRefund(receipt: RefundReceipt, expectedCents: number): Verified<{ paypalRefundId: string; status: "completed" | "pending" | "failed"; amountCents: number }> {
  if (!receipt.paypalRefundId) return incomplete("PayPal did not return a refund id.");
  const status = refundMoneyStatus(receipt.status);
  if (!status) return incomplete(`PayPal did not return a recognised refund status (${receipt.status ?? "none"}).`);
  const money = checkMoney(receipt, expectedCents, "refund");
  if (!money.ok) return money;
  return { ok: true, value: { paypalRefundId: receipt.paypalRefundId, status, amountCents: expectedCents } };
}

export interface VerifiedAuthorization {
  paypalAuthorizationId: string;
  status: NonNullable<ReturnType<typeof holdStatus>>;
  amountCents: number;
  createdAt: Date | null;
  expiresAt: Date | null;
}

export function verifyAuthorization(receipt: AuthorizationReceipt, expected: { amountCents: number; orderId: string; customId: string }): Verified<VerifiedAuthorization> {
  if (!receipt.paypalAuthorizationId) return incomplete("PayPal did not return an authorization id.");
  const status = holdStatus(receipt.status);
  if (!status) return incomplete(`PayPal did not return a recognised authorization status (${receipt.status ?? "none"}).`);
  const money = checkMoney(receipt, expected.amountCents, "authorization");
  if (!money.ok) return money;
  if (receipt.orderId !== undefined && receipt.orderId !== expected.orderId) return mismatch(`The authorization belongs to PayPal order ${receipt.orderId}, not ${expected.orderId}.`);
  if (receipt.customId !== undefined && receipt.customId !== expected.customId) return mismatch("The authorization was created for a different Setti operation.");
  return { ok: true, value: { paypalAuthorizationId: receipt.paypalAuthorizationId, status, amountCents: expected.amountCents, createdAt: date(receipt.createTime), expiresAt: date(receipt.expirationTime) } };
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
