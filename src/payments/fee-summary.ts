import type { SettlementView } from "./fees";
import type { CaptureView, PaymentLineView, RefundView } from "./types";

type Observation = SettlementView & { observedAt: string | null };
type CaptureWithSettlement = CaptureView & { settlement?: Observation };
type RefundWithSettlement = RefundView & { settlement?: Observation };

export interface FeeSummaryRow extends Observation {
  kind: "capture" | "refund";
  resourceId: string;
  label: string;
  amountCents: number;
}

export interface FeeSummary {
  captureFeeCents: number | null;
  refundFeeCents: number | null;
  /** Reported capture credits minus reported refund debits; may be negative. */
  merchantNetCents: number | null;
  completedCaptureCount: number;
  completedRefundCount: number;
  pendingCaptureCount: number;
  pendingRefundCount: number;
  rows: FeeSummaryRow[];
}

interface Candidate {
  kind: FeeSummaryRow["kind"];
  resourceId: string;
  label: string;
  amountCents: number;
  status: string;
  settlement?: Observation;
  conflict: boolean;
}

const cents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const unknown = (state: Exclude<SettlementView["state"], "reported">, reason: string, observedAt: string | null): Observation => ({ state, reason, grossCents: null, feeCents: null, netCents: null, observedAt });

function fingerprint(candidate: Candidate): string {
  const value = candidate.settlement;
  return JSON.stringify([candidate.amountCents, candidate.status, value?.state ?? "missing", value?.grossCents ?? null, value?.feeCents ?? null, value?.netCents ?? null]);
}

function latest(first: string | null, second: string | null): string | null {
  const a = first ? Date.parse(first) : NaN, b = second ? Date.parse(second) : NaN;
  if (Number.isFinite(b) && (!Number.isFinite(a) || b > a)) return second;
  return Number.isFinite(a) ? first : null;
}

function observation(candidate: Candidate): Observation {
  const value = candidate.settlement;
  const observedAt = value?.observedAt ?? null;
  if (!candidate.resourceId || candidate.conflict) return unknown("invalid", "Conflicting or missing transaction identity; reconcile this record before using its seller amounts.", observedAt);
  if (!value) return unknown("missing", "PayPal seller breakdown has not been recorded.", null);
  if (value.state !== "reported") return unknown(value.state, value.reason ?? "The seller breakdown is unavailable.", observedAt);
  if (!cents(candidate.amountCents) || !cents(value.grossCents) || !cents(value.feeCents) || !cents(value.netCents)
      || value.grossCents !== candidate.amountCents || value.feeCents > value.grossCents || value.grossCents - value.feeCents !== value.netCents) {
    return unknown("invalid", "The seller breakdown is incomplete or does not reconcile to this transaction.", observedAt);
  }
  return { ...value, observedAt };
}

function sum(rows: readonly FeeSummaryRow[], field: "feeCents" | "netCents"): number | null {
  let total = 0;
  for (const row of rows) {
    const amount = row[field];
    if (row.state !== "reported" || !cents(amount)) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Summarises completed provider resources once, never call attempts or quote totals. */
export function summarizePaymentFees(lines: readonly PaymentLineView[]): FeeSummary {
  const resources = new Map<string, Candidate>();
  function add(candidate: Omit<Candidate, "conflict">, fallbackId: string) {
    const key = `${candidate.kind}:${candidate.resourceId || `missing:${fallbackId}`}`;
    const previous = resources.get(key);
    if (!previous) { resources.set(key, { ...candidate, conflict: !candidate.resourceId }); return; }
    previous.conflict ||= fingerprint(previous) !== fingerprint({ ...candidate, conflict: false });
    if (previous.status !== candidate.status) {
      // A completed record must not disappear from totals because a duplicate contradicts it.
      if (candidate.status === "completed") previous.status = "completed";
      else if (previous.status !== "completed" && candidate.status === "pending") previous.status = "pending";
    }
    if (previous.settlement) previous.settlement = { ...previous.settlement, observedAt: latest(previous.settlement.observedAt, candidate.settlement?.observedAt ?? null) };
  }
  for (const line of lines) {
    for (const capture of line.captures as CaptureWithSettlement[]) add({ kind: "capture", resourceId: capture.paypalCaptureId, label: line.label, amountCents: capture.amountCents, status: capture.status, settlement: capture.settlement }, capture.id);
    for (const refund of line.refunds as RefundWithSettlement[]) add({ kind: "refund", resourceId: refund.paypalRefundId, label: line.label, amountCents: refund.amountCents, status: refund.status, settlement: refund.settlement }, refund.id);
  }
  const completed = [...resources.values()].filter((entry) => entry.status === "completed");
  const rows = completed.map((entry): FeeSummaryRow => ({ kind: entry.kind, resourceId: entry.resourceId, label: entry.label, amountCents: entry.amountCents, ...observation(entry) }));
  const captures = rows.filter((row) => row.kind === "capture"), refunds = rows.filter((row) => row.kind === "refund");
  const credits = sum(captures, "netCents"), debits = sum(refunds, "netCents");
  const merchantNet = credits === null || debits === null ? null : credits - debits;
  return {
    captureFeeCents: sum(captures, "feeCents"), refundFeeCents: sum(refunds, "feeCents"),
    merchantNetCents: merchantNet !== null && Number.isSafeInteger(merchantNet) ? merchantNet : null,
    completedCaptureCount: captures.length, completedRefundCount: refunds.length,
    pendingCaptureCount: [...resources.values()].filter((entry) => entry.kind === "capture" && entry.status === "pending").length,
    pendingRefundCount: [...resources.values()].filter((entry) => entry.kind === "refund" && entry.status === "pending").length,
    rows,
  };
}
