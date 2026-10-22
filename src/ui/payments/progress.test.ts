import { describe, expect, it } from "vitest";
import type { OperationView, PaymentLineView, PaymentStep, SupplierEventView } from "../../payments/types";
import { lineProgress, paymentScopeTotals } from "./progress";

const line = (patch: Partial<PaymentLineView> = {}): PaymentLineView => ({
  itemId: "rug", side: "baseline", label: "Rug", category: "service", changed: true, change: "remove",
  targetCents: 6_000, heldCents: 0, capturedCents: 30_000, refundedCents: 0, releasedCents: 0,
  holds: [], captures: [], refunds: [], confirmedTerms: null, supplierEvents: [], steps: [], ...patch,
});
const step = (kind: PaymentStep["kind"]): PaymentStep => ({ kind, actor: "designer", amountCents: 24_000, available: true, note: "" });
const operation = (patch: Partial<OperationView> = {}): OperationView => ({
  id: "op", businessItemId: "business-desk", kind: "capture", status: "unknown", amountCents: 110_000,
  itemLabel: "Desk", version: 2, requestId: "request", attempts: 1, paypalOrderId: "ORDER", approvalUrl: null,
  paypalResourceId: null, failureCode: null, failureMessage: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", calls: [], ...patch,
});
const supplier = (patch: Partial<SupplierEventView> = {}): SupplierEventView => ({
  id: "supplier", kind: "order_confirmed", quantity: 1, unitPriceCents: 110_000, taxCents: 0, freightCents: 0,
  totalCents: 110_000, inStock: true, leadTimeDays: 14, reference: "DEMO", note: "Demo supplier confirmation", isDemo: true, createdAt: "2026-10-21T00:00:00Z", ...patch,
});

describe("per-item payment progress", () => {
  it("does not call the old paid rug settled while its return still awaits supplier credit", () => {
    expect(lineProgress(line({ steps: [step("supplier_credit"), step("refund")] }))).toMatchObject({ label: "Awaiting supplier credit", settled: false });
    expect(lineProgress(line({ steps: [step("refund")] }))).toMatchObject({ label: "Refund required", settled: false });
  });

  it("keeps a completed new purchase separate from the old item's outstanding refund", () => {
    const rug = line({ steps: [step("supplier_credit")] });
    const desk = line({ itemId: "desk", side: "proposed", label: "Desk", category: "furniture", change: "replace", targetCents: 110_000, capturedCents: 110_000 });
    const chair = line({ itemId: "chair", targetCents: 0, capturedCents: 0, releasedCents: 80_000 });
    expect([chair, rug, desk].map((entry) => lineProgress(entry).settled)).toEqual([true, false, true]);
    expect(paymentScopeTotals([chair, rug, desk])).toEqual({ heldCents: 0, capturedCents: 140_000, refundedCents: 0, releasedCents: 80_000 });
    expect(lineProgress({ ...rug, refundedCents: 24_000, steps: [] })).toMatchObject({ label: "Refund completed", settled: true });
  });

  it("waits for pending provider results even when a capture already covers the target", () => {
    const captured = line({ targetCents: 30_000, captures: [{ id: "capture", paypalCaptureId: "CAP", authorizationId: null, amountCents: 30_000, status: "pending", finalCapture: true, refundedCents: 0, pendingRefundCents: 0, operationId: "op", createdAt: "2026-10-21T00:00:00Z" }] });
    expect(lineProgress(captured)).toMatchObject({ label: "Capture pending at PayPal", settled: false });
    const refunded = line({ refunds: [{ id: "refund", paypalRefundId: "REF", captureId: "capture", amountCents: 24_000, status: "pending", operationId: "op", createdAt: "2026-10-21T00:00:00Z" }] });
    expect(lineProgress(refunded)).toMatchObject({ label: "Refund pending at PayPal", settled: false });
  });

  it("distinguishes a release, a partial funding gap and supplier-gated capture", () => {
    expect(lineProgress(line({ targetCents: 0, capturedCents: 0, heldCents: 80_000 }))).toMatchObject({ label: "Hold release required", settled: false });
    const furniture = line({ category: "furniture", targetCents: 110_000, capturedCents: 0, heldCents: 80_000 });
    expect(lineProgress(furniture).label).toBe("Additional authorization needed");
    expect(lineProgress({ ...furniture, heldCents: 110_000, steps: [step("supplier_confirmation")] }).label).toBe("Awaiting supplier confirmation");
    expect(lineProgress({ ...furniture, heldCents: 110_000, steps: [step("capture")], supplierEvents: [supplier()] }).label).toBe("Ready for capture");
  });

  it("preserves the rug's supplier-credit dependency when another item's open operation blocks and clears all steps", () => {
    const rug = line({ businessItemId: "business-rug", refundRequiresSupplierCredit: true, steps: [] });
    const pendingDesk = operation({ kind: "authorize", status: "pending", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST" });
    expect(lineProgress(rug, [pendingDesk])).toMatchObject({ label: "Awaiting supplier credit", settled: false });
    expect(lineProgress({ ...rug, supplierEvents: [supplier({ kind: "credit_confirmed", totalCents: 24_000 })] }, [pendingDesk])).toMatchObject({ label: "Refund required", settled: false });
  });

  it("requires reconciliation of an unknown desk capture even if supplier terms match or recorded captures cover its target", () => {
    const desk = line({ itemId: "desk", businessItemId: "business-desk", category: "furniture", targetCents: 110_000, capturedCents: 0, heldCents: 110_000, supplierEvents: [supplier()], steps: [] });
    expect(lineProgress(desk, [operation()])).toMatchObject({ label: "Capture outcome unknown", tone: "waiting", settled: false });
    expect(lineProgress({ ...desk, heldCents: 0, capturedCents: 110_000 }, [operation()])).toMatchObject({ label: "Capture outcome unknown", settled: false });
  });

  it("binds old and proposed replacement progress only by stable business identity, never shared quote ids or labels", () => {
    const old = line({ itemId: "same-quote-id", label: "Same label", businessItemId: "business-old", capturedCents: 0, targetCents: 0, releasedCents: 80_000 });
    const replacement = line({ ...old, side: "proposed", businessItemId: "business-desk", category: "furniture", targetCents: 110_000, capturedCents: 110_000, releasedCents: 0 });
    const unresolved = operation({ itemLabel: "Same label" });
    expect(lineProgress(old, [unresolved])).toMatchObject({ label: "Hold released", settled: true });
    expect(lineProgress(replacement, [unresolved])).toMatchObject({ label: "Capture outcome unknown", settled: false });
    expect(lineProgress({ ...old, businessItemId: null }, [{ ...unresolved, businessItemId: null }]).settled).toBe(true);
  });

  it.each(["authorize", "capture", "void", "refund"] as const)("keeps a pending or unknown %s operation ahead of settled balances", (kind) => {
    const paid = line({ businessItemId: "business-desk", targetCents: 30_000 });
    expect(lineProgress(paid, [operation({ kind, status: "pending" })])).toMatchObject({ tone: "waiting", settled: false });
    expect(lineProgress(paid, [operation({ kind, status: "unknown" })])).toMatchObject({ tone: "waiting", settled: false });
  });

  it("continues an existing buyer checkout rather than suggesting a new authorization", () => {
    const desk = line({ businessItemId: "business-desk", category: "furniture", targetCents: 110_000, capturedCents: 0 });
    expect(lineProgress(desk, [operation({ kind: "authorize", status: "pending", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST" })])).toMatchObject({ label: "Awaiting client approval", settled: false });
  });
});
