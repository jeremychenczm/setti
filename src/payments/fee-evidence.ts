import { readSettlement } from "./fees";
import type { RecordedSettlement } from "./types";

export interface FeeObservation {
  step: string;
  outcome: string;
  resourceId: string | null;
  resourceStatus: string | null;
  amountCents: number | null;
  currency: string | null;
  details: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

/**
 * One observation per transaction, never a sum of HTTP calls or retries.
 * A lookup PayPal did not answer (rejected, unknown, retryable) carries no new
 * seller amounts, so the latest answered observation still stands, with a note.
 * An answer that disagrees with the transaction always replaces earlier values.
 */
export function recordedSettlement(kind: "capture" | "refund", id: string, amountCents: number, calls: readonly FeeObservation[]): RecordedSettlement {
  const steps = kind === "capture" ? ["capture", "get_capture"] : ["refund", "get_refund"];
  const observations = calls.filter((call) => call.resourceId === id && steps.includes(call.step))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = observations[0];
  const answered = observations.find((call) => call.outcome === "ok");
  const unknown = (state: "missing" | "invalid", reason: string, at = answered ?? latest): RecordedSettlement => ({ state, grossCents: null, feeCents: null, netCents: null, reason, observedAt: at?.createdAt.toISOString() ?? null });
  if (!latest) return unknown("missing", "No PayPal seller breakdown is recorded for this transaction.");
  if (!answered) return unknown("missing", "The latest PayPal fee lookup did not succeed. The saved payment state was not changed.", latest);
  if (answered.details.settlementLookupError) return unknown("invalid", String(answered.details.settlementLookupError));
  if (answered.amountCents !== amountCents || answered.currency !== "USD") return unknown("invalid", "The latest PayPal observation does not match this transaction's amount and currency.");
  const settled = kind === "capture" ? ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] : ["COMPLETED"];
  if (!settled.includes(answered.resourceStatus ?? "")) return unknown("missing", "PayPal did not establish a completed transaction for this fee observation.");
  const view = readSettlement(kind, amountCents, "USD", answered.details);
  const refreshFailed = answered !== latest && view.state === "reported";
  return { ...view, ...(refreshFailed ? { reason: `The latest PayPal fee lookup at ${latest.createdAt.toISOString()} did not succeed; these are the last answered amounts.` } : {}), observedAt: answered.createdAt.toISOString() };
}
