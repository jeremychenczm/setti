import { describe, expect, it } from "vitest";
import { recordedSettlement, type FeeObservation } from "./fee-evidence";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 4, minute));
const breakdown = { settlementPresent: true, settlementVersion: 1, settlementGrossCents: 10_000, settlementGrossCurrency: "USD", settlementFeeCents: 398, settlementFeeCurrency: "USD", settlementNetCents: 9_602, settlementNetCurrency: "USD", settlementPlatformFeesPresent: false, settlementConversionPresent: false, settlementMalformed: false };
const call = (minute: number, patch: Partial<FeeObservation> = {}): FeeObservation => ({ step: "get_capture", outcome: "ok", resourceId: "CAP-1", resourceStatus: "COMPLETED", amountCents: 10_000, currency: "USD", details: breakdown, createdAt: at(minute), ...patch });

describe("recorded seller breakdown per transaction", () => {
  it("keeps the last answered amounts and notes a later lookup PayPal did not answer", () => {
    const view = recordedSettlement("capture", "CAP-1", 10_000, [call(1), call(2, { outcome: "unknown", resourceStatus: null, amountCents: null, currency: null, details: {} })]);
    expect(view).toMatchObject({ state: "reported", feeCents: 398, netCents: 9_602, observedAt: at(1).toISOString() });
    expect(view.reason).toMatch(/did not succeed; these are the last answered amounts/);
  });

  it("replaces earlier amounts when a later PayPal answer disagrees with the transaction", () => {
    const disagreeing = call(2, { details: { settlementRead: true, settlementLookupError: "PayPal returned a different identity, amount, currency or transaction state." } });
    expect(recordedSettlement("capture", "CAP-1", 10_000, [call(1), disagreeing])).toMatchObject({ state: "invalid", feeCents: null, observedAt: at(2).toISOString() });
  });

  it("stays unknown when no lookup was answered", () => {
    const view = recordedSettlement("capture", "CAP-1", 10_000, [call(1, { outcome: "rejected", details: {} })]);
    expect(view).toMatchObject({ state: "missing", feeCents: null, netCents: null });
    expect(view.reason).toMatch(/did not succeed/);
  });

  it("never uses another transaction's or another step's observation", () => {
    const calls = [call(1, { resourceId: "CAP-2" }), call(2, { step: "get_refund" })];
    expect(recordedSettlement("capture", "CAP-1", 10_000, calls)).toMatchObject({ state: "missing", observedAt: null });
  });
});
