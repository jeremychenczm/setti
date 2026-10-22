import { describe, expect, it } from "vitest";
import type { SettlementView } from "./fees";
import { summarizePaymentFees } from "./fee-summary";
import type { CaptureView, PaymentLineView, RefundView } from "./types";

const time = "2026-10-22T04:00:00Z";
type Observation = SettlementView & { observedAt: string | null };
type Capture = CaptureView & { settlement?: Observation };
type Refund = RefundView & { settlement?: Observation };
const reported = (grossCents: number, feeCents: number): Observation => ({ state: "reported", grossCents, feeCents, netCents: grossCents - feeCents, reason: null, observedAt: time });
const capture = (patch: Partial<Capture> = {}): Capture => ({ id: "capture", paypalCaptureId: "CAPTURE-1", authorizationId: "hold", amountCents: 30_000, status: "completed", finalCapture: true, refundedCents: 24_000, pendingRefundCents: 0, operationId: "capture-op", createdAt: time, settlement: reported(30_000, 1_100), ...patch });
const refund = (patch: Partial<Refund> = {}): Refund => ({ id: "refund", paypalRefundId: "REFUND-1", captureId: "capture", amountCents: 24_000, status: "completed", operationId: "refund-op", createdAt: time, settlement: reported(24_000, 0), ...patch });
const line = (captures: Capture[] = [], refunds: Refund[] = []): PaymentLineView => ({ itemId: "rug", side: "baseline", label: "Wool rug", category: "furniture", changed: true, change: "remove", targetCents: 6_000, heldCents: 0, capturedCents: 30_000, refundedCents: 24_000, releasedCents: 0, holds: [], captures, refunds, confirmedTerms: null, supplierEvents: [], steps: [] });

describe("recorded merchant fee summary", () => {
  it("distinguishes retained gross from the merchant net after a partial refund", () => {
    const result = summarizePaymentFees([line([capture()], [refund()])]);
    expect(result).toMatchObject({ captureFeeCents: 1_100, refundFeeCents: 0, merchantNetCents: 4_900, completedCaptureCount: 1, completedRefundCount: 1 });
    expect(result.merchantNetCents).not.toBe(6_000);
  });
  it("subtracts the refund debit and treats its fee as a credit", () => {
    expect(summarizePaymentFees([line([capture()], [refund({ settlement: reported(24_000, 100) })])])).toMatchObject({ captureFeeCents: 1_100, refundFeeCents: 100, merchantNetCents: 5_000 });
  });
  it("deduplicates provider identities across lines without summing repeated observations", () => {
    const first = line([capture()], [refund()]);
    const duplicate = line([capture({ id: "different-local-row", settlement: { ...reported(30_000, 1_100), observedAt: "2026-10-22T05:00:00Z" } })], [refund()]);
    const result = summarizePaymentFees([first, duplicate]);
    expect(result).toMatchObject({ captureFeeCents: 1_100, refundFeeCents: 0, merchantNetCents: 4_900 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].observedAt).toBe("2026-10-22T05:00:00Z");
  });
  it.each(["amount", "seller amounts", "status"])("keeps conflicting duplicate %s unknown", (conflict) => {
    const duplicate = capture(conflict === "amount" ? { amountCents: 31_000 } : conflict === "status" ? { status: "pending" } : { settlement: reported(30_000, 0) });
    const result = summarizePaymentFees([line([capture(), duplicate], [refund()])]);
    expect(result.captureFeeCents).toBeNull();
    expect(result.merchantNetCents).toBeNull();
    expect(result.refundFeeCents).toBe(0);
    expect(result.rows[0]).toMatchObject({ state: "invalid", feeCents: null });
  });
  it("does not substitute gross amounts when old records have no seller breakdown", () => {
    const result = summarizePaymentFees([line([capture({ settlement: undefined })], [refund()])]);
    expect(result.captureFeeCents).toBeNull();
    expect(result.merchantNetCents).toBeNull();
    expect(result.rows[0].state).toBe("missing");
  });
  it.each(["missing", "invalid", "unsupported"] as const)("preserves an unavailable %s refund breakdown", (state) => {
    const result = summarizePaymentFees([line([capture()], [refund({ settlement: { state, grossCents: null, feeCents: null, netCents: null, reason: "Provider record needs review", observedAt: time } })])]);
    expect(result.captureFeeCents).toBe(1_100);
    expect(result.refundFeeCents).toBeNull();
    expect(result.merchantNetCents).toBeNull();
  });
  it("excludes pending and failed records even when their seller fields exist", () => {
    const result = summarizePaymentFees([line([capture(), capture({ id: "pending", paypalCaptureId: "CAPTURE-2", status: "pending" }), capture({ id: "declined", paypalCaptureId: "CAPTURE-3", status: "declined" })], [refund(), refund({ id: "pending-refund", paypalRefundId: "REFUND-2", status: "pending" }), refund({ id: "failed", paypalRefundId: "REFUND-3", status: "failed" })])]);
    expect(result).toMatchObject({ merchantNetCents: 4_900, pendingCaptureCount: 1, pendingRefundCount: 1, completedCaptureCount: 1, completedRefundCount: 1 });
  });
  it("allows zero reported fees and a negative merchant net", () => {
    expect(summarizePaymentFees([line([capture({ settlement: reported(30_000, 0) })])]).captureFeeCents).toBe(0);
    const result = summarizePaymentFees([line([capture()], [refund({ amountCents: 30_000, settlement: reported(30_000, 0) })])]);
    expect(result.merchantNetCents).toBe(-1_100);
  });
  it("keeps separate partial refund resources rather than summing cumulative totals", () => {
    const result = summarizePaymentFees([line([capture()], [refund({ amountCents: 10_000, settlement: reported(10_000, 0) }), refund({ id: "refund-2", paypalRefundId: "REFUND-2", amountCents: 14_000, settlement: reported(14_000, 0) })])]);
    expect(result).toMatchObject({ merchantNetCents: 4_900, completedRefundCount: 2 });
  });
  it("fails closed on an incomplete reported view or missing resource identity", () => {
    expect(summarizePaymentFees([line([capture({ settlement: { ...reported(30_000, 1_100), netCents: null } })])]).merchantNetCents).toBeNull();
    expect(summarizePaymentFees([line([capture({ paypalCaptureId: "" })])]).captureFeeCents).toBeNull();
  });
  it("does not turn arithmetic overflow into a merchant total", () => {
    const amountCents = Number.MAX_SAFE_INTEGER;
    const rows = [capture({ amountCents, settlement: reported(amountCents, 0) }), capture({ id: "second", paypalCaptureId: "CAPTURE-2", amountCents, settlement: reported(amountCents, 0) })];
    expect(summarizePaymentFees([line(rows)]).merchantNetCents).toBeNull();
  });
  it("reports no completed records independently from quote and held amounts", () => {
    const result = summarizePaymentFees([line()]);
    expect(result.rows).toEqual([]);
    expect(result.completedCaptureCount + result.completedRefundCount).toBe(0);
  });
});
