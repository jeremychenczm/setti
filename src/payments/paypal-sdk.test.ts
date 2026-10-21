import type { OrdersController, PaymentsController } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { createSdkPayPal } from "./paypal-sdk";

const response = <T>(result: T, statusCode = 201) => ({ result, statusCode, headers: { "Paypal-Debug-Id": "debug-1" } });

function adapter(payments: Partial<PaymentsController>, orders: Partial<OrdersController> = {}) {
  return createSdkPayPal({ payments: payments as PaymentsController, orders: orders as OrdersController });
}

describe("PayPal SDK adapter", () => {
  it("copies a capture receipt without inventing a status or an amount", async () => {
    const paypal = adapter({ captureAuthorizedPayment: async () => response({ id: "CAP-1" }) } as never);
    const result = await paypal.captureAuthorization({ paypalAuthorizationId: "AUTH-1", amountCents: 54_375, finalCapture: true, requestId: "r1" });
    expect(result).toEqual({ kind: "ok", value: { paypalCaptureId: "CAP-1", status: undefined, amountCents: undefined, currency: undefined, finalCapture: undefined, createTime: undefined }, trace: { httpStatus: 201, debugId: "debug-1" } });
  });

  it("sends exact decimal amounts and the operation's request id", async () => {
    let sent: unknown;
    const paypal = adapter({ captureAuthorizedPayment: async (request: unknown) => { sent = request; return response({ id: "CAP-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "271.88" } }); } } as never);
    const result = await paypal.captureAuthorization({ paypalAuthorizationId: "AUTH-1", amountCents: 27_188, finalCapture: true, requestId: "setti-op-1" });
    expect(sent).toMatchObject({ authorizationId: "AUTH-1", paypalRequestId: "setti-op-1", body: { amount: { currencyCode: "USD", value: "271.88" }, finalCapture: true } });
    expect(result).toMatchObject({ kind: "ok", value: { status: "COMPLETED", amountCents: 27_188, currency: "USD" } });
  });

  it("reads an order's approval link and its authorization", async () => {
    const order = {
      id: "ORDER-1", status: "COMPLETED", links: [{ rel: "self", href: "https://api.sandbox.paypal.com/x" }, { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }],
      purchaseUnits: [{ amount: { currencyCode: "USD", value: "543.75" }, customId: "op-1", payments: { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currencyCode: "USD", value: "543.75" }, customId: "op-1", expirationTime: "2026-11-19T00:00:00Z" }] } }],
    };
    const paypal = adapter({}, { getOrder: async () => response(order, 200) } as never);
    expect(await paypal.getOrder("ORDER-1")).toMatchObject({
      kind: "ok",
      value: { orderId: "ORDER-1", status: "COMPLETED", amountCents: 54_375, approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", authorization: { paypalAuthorizationId: "AUTH-1", status: "CREATED", amountCents: 54_375, orderId: "ORDER-1", customId: "op-1" } },
    });
  });

  it("classifies a thrown network error without a response as an unknown outcome", async () => {
    const paypal = adapter({ voidPayment: async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); } } as never);
    expect(await paypal.voidAuthorization({ paypalAuthorizationId: "AUTH-1", requestId: "r1" })).toMatchObject({ kind: "unknown", message: "socket hang up" });
  });
});
