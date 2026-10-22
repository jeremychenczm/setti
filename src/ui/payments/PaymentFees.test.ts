import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementView } from "../../payments/fees";
import type { CaptureView, PaymentLineView, RefundView } from "../../payments/types";
import { PaymentFees } from "./PaymentFees";

const time = "2026-10-22T04:00:00Z";
type Observation = SettlementView & { observedAt: string | null };
const reported = (grossCents: number, feeCents: number): Observation => ({ state: "reported", grossCents, feeCents, netCents: grossCents - feeCents, reason: null, observedAt: time });
const capture = (settlement?: Observation): CaptureView & { settlement?: Observation } => ({ id: "capture", paypalCaptureId: "CAPTURE-SOURCE", authorizationId: null, amountCents: 30_000, status: "completed", finalCapture: true, refundedCents: 24_000, pendingRefundCents: 0, operationId: "capture-op", createdAt: time, settlement });
const refund = (settlement?: Observation): RefundView & { settlement?: Observation } => ({ id: "refund", paypalRefundId: "REFUND-SOURCE", captureId: "capture", amountCents: 24_000, status: "completed", operationId: "refund-op", createdAt: time, settlement });
const line = (captures: CaptureView[] = [], refunds: RefundView[] = []): PaymentLineView => ({ itemId: "rug", side: "baseline", label: "Wool rug", category: "furniture", changed: true, change: "remove", targetCents: 6_000, heldCents: 0, capturedCents: 30_000, refundedCents: 24_000, releasedCents: 0, holds: [], captures, refunds, confirmedTerms: null, supplierEvents: [], steps: [] });
const render = (lines: PaymentLineView[]) => renderToStaticMarkup(createElement(PaymentFees, { lines }));

describe("PayPal fee evidence display", () => {
  it("shows merchant net separately from retained gross, with source IDs and observation time", () => {
    const html = render([line([capture(reported(30_000, 1_100))], [refund(reported(24_000, 0))])]);
    expect(html).toContain("PayPal fees charged");
    expect(html).toContain("Fees credited on refunds");
    expect(html).toContain("Merchant net · recorded completed transactions");
    expect(html).toContain("$49.00");
    expect(html).toContain("$11.00");
    expect(html).toContain("CAPTURE-SOURCE");
    expect(html).toContain("REFUND-SOURCE");
    expect(html).toMatch(/datetime="2026-10-22T04:00:00Z"/i);
    expect(html).toContain("neither profit nor an account balance");
    expect(html).toContain("does not query PayPal");
  });
  it("keeps missing seller fields unknown instead of showing zero fees or gross as merchant net", () => {
    const html = render([line([capture()])]);
    expect(html).toContain("Unknown");
    expect(html).toContain("missing fees are not zero");
    expect(html).not.toContain("$300.00");
  });
  it("shows no completed records rather than a paid or settled zero total", () => {
    const html = render([line()]);
    expect(html).toContain("No completed capture or refund records");
    expect(html).toContain("does not mean the project is paid or settled");
    expect(html).not.toContain("$0.00");
  });
  it("excludes pending seller amounts and tells the reader they are unsettled", () => {
    const pending = { ...refund(reported(24_000, 0)), status: "pending" as const };
    const html = render([line([capture(reported(30_000, 1_100))], [pending])]);
    expect(html).toContain("$289.00");
    expect(html).toContain("0 pending captures and 1 pending refund excluded");
    expect(html).not.toContain("$49.00");
  });
  it("renders negative merchant net without turning it into an account balance", () => {
    const refunded = { ...refund(reported(30_000, 0)), amountCents: 30_000 };
    expect(render([line([capture(reported(30_000, 1_100))], [refunded])])).toContain("-$11.00");
  });
  it("offers the GET-only fee lookup only to the owning browser with completed records", () => {
    const lines = [line([capture(reported(30_000, 1_100))])];
    const owner = renderToStaticMarkup(createElement(PaymentFees, { lines, onRefresh: () => {} }));
    expect(owner).toContain("Read fees from PayPal");
    expect(owner).toContain("runs no payment step");
    expect(render(lines)).not.toContain("Read fees from PayPal");
    expect(renderToStaticMarkup(createElement(PaymentFees, { lines: [line()], onRefresh: () => {} }))).not.toContain("Read fees from PayPal");
  });
  it("shows that a later lookup failed while keeping the last answered amounts", () => {
    const kept = { ...reported(30_000, 1_100), reason: "The latest PayPal fee lookup at 2026-10-22T05:00:00.000Z did not succeed; these are the last answered amounts." };
    const html = render([line([capture(kept)])]);
    expect(html).toContain("$289.00");
    expect(html).toContain("these are the last answered amounts");
  });
  it("escapes resource labels and untrusted failure explanations", () => {
    const malicious = line([capture({ state: "invalid", grossCents: null, feeCents: null, netCents: null, reason: '<script>alert("fee")</script>', observedAt: null })]);
    malicious.label = '<img src=x onerror="alert(1)">';
    malicious.captures[0].paypalCaptureId = '<script>resource</script>';
    const html = render([malicious]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("href=");
  });
});
