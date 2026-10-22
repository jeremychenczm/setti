import { describe, expect, it } from "vitest";
import { readSettlement, settlementDetails } from "./fees";
import type { CaptureReceipt, ReportedSettlement } from "./paypal";

const breakdown = (gross = 10_000, fee = 398, net = 9_602): ReportedSettlement => ({
  gross: { amountCents: gross, currency: "USD" }, fee: { amountCents: fee, currency: "USD" }, net: { amountCents: net, currency: "USD" },
  platformFeesPresent: false, conversionPresent: false,
});
const details = (settlement = breakdown()) => settlementDetails({ settlement });

describe("provider-reported seller breakdowns", () => {
  it("round-trips exact capture amounts without adding a fee to the client price", () => {
    expect(readSettlement("capture", 10_000, "USD", details())).toEqual({ state: "reported", grossCents: 10_000, feeCents: 398, netCents: 9_602, reason: null });
  });

  it("preserves an explicit zero refund fee and the full merchant refund debit", () => {
    expect(readSettlement("refund", 24_000, "USD", details(breakdown(24_000, 0, 24_000)))).toEqual({ state: "reported", grossCents: 24_000, feeCents: 0, netCents: 24_000, reason: null });
  });

  it("reads a credited-back refund fee component rather than charging another refund fee", () => {
    expect(readSettlement("refund", 10_000, "USD", details(breakdown(10_000, 100, 9_900)))).toEqual({ state: "reported", grossCents: 10_000, feeCents: 100, netCents: 9_900, reason: null });
  });

  it("does not invent a zero breakdown for older recorded transactions", () => {
    expect(settlementDetails({ paypalCaptureId: "CAP-1" })).toEqual({});
    expect(readSettlement("capture", 10_000, "USD", {})).toMatchObject({ state: "missing", grossCents: null, feeCents: null, netCents: null });
  });

  it.each(["gross", "fee", "net"] as const)("retains missing %s as unknown through JSON persistence", (field) => {
    const settlement = breakdown();
    settlement[field] = {};
    const recorded = JSON.parse(JSON.stringify(details(settlement)));
    expect(readSettlement("capture", 10_000, "USD", recorded)).toMatchObject({ state: "missing", grossCents: null, feeCents: null, netCents: null });
  });

  it.each(["gross", "fee", "net"] as const)("requires a currency on %s", (field) => {
    const settlement = breakdown();
    delete settlement[field].currency;
    expect(readSettlement("capture", 10_000, "USD", details(settlement)).state).toBe("missing");
  });

  it.each([
    ["wrong transaction gross", { settlementGrossCents: 10_001 }],
    ["inconsistent net", { settlementNetCents: 9_601 }],
    ["fee larger than gross", { settlementFeeCents: 10_001 }],
    ["negative fee", { settlementFeeCents: -1 }],
    ["fractional cents", { settlementFeeCents: 0.5 }],
    ["unsafe amount", { settlementGrossCents: Number.MAX_SAFE_INTEGER + 1 }],
    ["string amount", { settlementFeeCents: "398" }],
    ["invalid currency type", { settlementFeeCurrency: 123 }],
    ["unknown format", { settlementVersion: 2 }],
    ["malformed SDK amount", { settlementMalformed: true }],
    ["malformed flag", { settlementConversionPresent: "false" }],
  ])("rejects %s without manufacturing partial totals", (_name, patch) => {
    const view = readSettlement("capture", 10_000, "USD", { ...details(), ...patch });
    expect(view).toMatchObject({ state: "invalid", grossCents: null, feeCents: null, netCents: null });
  });

  it.each<Record<string, string | boolean>>([
    { settlementPlatformFeesPresent: true },
    { settlementConversionPresent: true },
    { settlementNetCurrency: "EUR" },
  ])("does not mix platform fees or currencies into the narrow USD total: %j", (patch) => {
    expect(readSettlement("capture", 10_000, "USD", { ...details(), ...patch })).toMatchObject({ state: "unsupported", feeCents: null, netCents: null });
  });

  it("rejects a non-USD transaction even if the breakdown incorrectly says USD", () => {
    expect(readSettlement("capture", 10_000, "EUR", details()).state).toBe("unsupported");
  });

  it("serializes only the monetary allowlist", () => {
    const receipt: CaptureReceipt & { payer: string; token: string } = { settlement: breakdown(), payer: "private buyer", token: "private bearer" };
    const encoded = JSON.stringify(settlementDetails(receipt));
    expect(encoded).not.toMatch(/private|payer|token/);
    expect(JSON.parse(encoded)).toMatchObject({ settlementVersion: 1, settlementGrossCents: 10_000, settlementFeeCents: 398, settlementNetCents: 9_602 });
  });
});
