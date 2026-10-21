import { describe, expect, it } from "vitest";
import { captureMoneyStatus, formatCents, holdStatus, parseCents, refundMoneyStatus, verifyAuthorization, verifyCapture, verifyRefund } from "./receipts";

describe("receipt parsing", () => {
  it("reads PayPal decimal strings as exact cents and nothing else", () => {
    expect(parseCents("543.75")).toBe(54_375);
    expect(parseCents("271.88")).toBe(27_188);
    expect(parseCents("815.6")).toBe(81_560);
    expect(parseCents("100")).toBe(10_000);
    for (const value of [undefined, "", "-1.00", "1.005", "1e3", "12,00", " 5.00"]) expect(parseCents(value)).toBeUndefined();
    expect(formatCents(81_563)).toBe("815.63");
    expect(formatCents(5)).toBe("0.05");
    expect(() => formatCents(-1)).toThrow();
  });

  it("maps statuses without defaulting an unknown or missing status to money", () => {
    expect(captureMoneyStatus("COMPLETED")).toBe("completed");
    expect(captureMoneyStatus("PARTIALLY_REFUNDED")).toBe("completed");
    expect(captureMoneyStatus("PENDING")).toBe("pending");
    expect(captureMoneyStatus("DECLINED")).toBe("declined");
    expect(captureMoneyStatus("FAILED")).toBe("declined");
    expect(captureMoneyStatus(undefined)).toBeUndefined();
    expect(captureMoneyStatus("SOMETHING_NEW")).toBeUndefined();
    expect(refundMoneyStatus("CANCELLED")).toBe("failed");
    expect(refundMoneyStatus(undefined)).toBeUndefined();
    expect(holdStatus("PENDING")).toBe("pending");
    expect(holdStatus(undefined)).toBeUndefined();
  });

  it("accepts a capture receipt only with its id, a known status and the exact USD amount", () => {
    expect(verifyCapture({ paypalCaptureId: "C1", status: "COMPLETED", amountCents: 54_375, currency: "USD" }, 54_375)).toMatchObject({ ok: true, value: { status: "completed" } });
    expect(verifyCapture({ paypalCaptureId: "C1", status: "PENDING", amountCents: 54_375, currency: "USD" }, 54_375)).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(verifyCapture({ paypalCaptureId: "C1" }, 54_375)).toMatchObject({ ok: false, code: "RECEIPT_INCOMPLETE" });
    expect(verifyCapture({ paypalCaptureId: "C1", status: "COMPLETED" }, 54_375)).toMatchObject({ ok: false, code: "RECEIPT_INCOMPLETE" });
    expect(verifyCapture({ status: "COMPLETED", amountCents: 54_375, currency: "USD" }, 54_375)).toMatchObject({ ok: false, code: "RECEIPT_INCOMPLETE" });
    expect(verifyCapture({ paypalCaptureId: "C1", status: "COMPLETED", amountCents: 54_376, currency: "USD" }, 54_375)).toMatchObject({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(verifyCapture({ paypalCaptureId: "C1", status: "COMPLETED", amountCents: 54_375, currency: "EUR" }, 54_375)).toMatchObject({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(verifyRefund({ paypalRefundId: "R1", status: "COMPLETED", amountCents: 100, currency: "USD" }, 101)).toMatchObject({ ok: false, code: "RECEIPT_MISMATCH" });
  });

  it("checks an authorization's order and Setti operation, and keeps PayPal's expiry", () => {
    const receipt = { paypalAuthorizationId: "A1", status: "CREATED", amountCents: 54_375, currency: "USD", orderId: "O1", customId: "op-1", createTime: "2026-10-21T01:00:00Z", expirationTime: "2026-11-19T01:00:00Z" };
    const expected = { amountCents: 54_375, orderId: "O1", customId: "op-1" };
    expect(verifyAuthorization(receipt, expected)).toMatchObject({ ok: true, value: { status: "created", expiresAt: new Date("2026-11-19T01:00:00Z") } });
    expect(verifyAuthorization({ ...receipt, orderId: "O2" }, expected)).toMatchObject({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(verifyAuthorization({ ...receipt, customId: "op-2" }, expected)).toMatchObject({ ok: false, code: "RECEIPT_MISMATCH" });
    expect(verifyAuthorization({ ...receipt, status: undefined }, expected)).toMatchObject({ ok: false, code: "RECEIPT_INCOMPLETE" });
  });
});
