import { ApiError, type OrdersController, type PaymentsController } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { createSdkPayPal, createSdkTestCardApproval } from "./paypal-sdk";
import { readSettlement, settlementDetails } from "./fees";

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

  it("lists the order's refunds with their custom_id so a lost refund answer can be found", async () => {
    const paypal = adapter({}, { getOrder: async () => response({
      id: "ORDER-1", status: "COMPLETED", purchaseUnits: [{ payments: { refunds: [
        { id: "REFUND-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "271.88" }, customId: "operation-1" },
        { id: "REFUND-2", status: "COMPLETED", amount: { currencyCode: "USD", value: "10.00" } },
      ] } }],
    }, 200) } as never);
    const result = await paypal.getOrder("ORDER-1");
    expect(result).toMatchObject({ kind: "ok", value: { orderId: "ORDER-1", refunds: [
      { paypalRefundId: "REFUND-1", status: "COMPLETED", amountCents: 27_188, currency: "USD", customId: "operation-1" },
      { paypalRefundId: "REFUND-2", customId: undefined },
    ] } });
  });

  it("leaves refunds out of an order PayPal reports without any", async () => {
    const paypal = adapter({}, { getOrder: async () => response({ id: "ORDER-1", status: "COMPLETED", purchaseUnits: [{ payments: {} }] }, 200) } as never);
    const result = await paypal.getOrder("ORDER-1");
    if (result.kind !== "ok") throw new Error("Expected order receipt");
    expect(result.value).not.toHaveProperty("refunds");
  });

  it("reads the actual capture fee and merchant receipt from the SDK's seller breakdown", async () => {
    const paypal = adapter({ getCapturedPayment: async () => response({
      id: "CAP-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "100.00" },
      sellerReceivableBreakdown: { grossAmount: { currencyCode: "USD", value: "100.00" }, paypalFee: { currencyCode: "USD", value: "3.98" }, netAmount: { currencyCode: "USD", value: "96.02" } },
    }, 200) } as never);
    const result = await paypal.getCapture("CAP-1");
    expect(result).toMatchObject({ kind: "ok", value: { settlement: { gross: { amountCents: 10_000, currency: "USD" }, fee: { amountCents: 398, currency: "USD" }, net: { amountCents: 9_602, currency: "USD" } } } });
    if (result.kind !== "ok") throw new Error("Expected capture receipt");
    expect(readSettlement("capture", 10_000, "USD", settlementDetails(result.value)).state).toBe("reported");
  });

  it("keeps the refund breakdown separate from the capture and ignores cumulative refunded totals", async () => {
    const paypal = adapter({ getRefund: async () => response({
      id: "REFUND-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "1.00" },
      sellerPayableBreakdown: { grossAmount: { currencyCode: "USD", value: "1.00" }, paypalFee: { currencyCode: "USD", value: "0.00" }, netAmount: { currencyCode: "USD", value: "1.00" }, totalRefundedAmount: { currencyCode: "USD", value: "11.00" } },
    }, 200) } as never);
    const result = await paypal.getRefund("REFUND-1");
    if (result.kind !== "ok") throw new Error("Expected refund receipt");
    expect(readSettlement("refund", 100, "USD", settlementDetails(result.value))).toMatchObject({ state: "reported", grossCents: 100, feeCents: 0, netCents: 100 });
    expect(JSON.stringify(result.value.settlement)).not.toContain("1100");
  });

  it("records a partial breakdown as missing instead of inferring zero fees", async () => {
    const paypal = adapter({ getCapturedPayment: async () => response({ id: "CAP-1", amount: { currencyCode: "USD", value: "100.00" }, sellerReceivableBreakdown: { grossAmount: { currencyCode: "USD", value: "100.00" } } }, 200) } as never);
    const result = await paypal.getCapture("CAP-1");
    if (result.kind !== "ok") throw new Error("Expected capture receipt");
    expect(result.value.settlement).toMatchObject({ fee: { amountCents: undefined, currency: undefined }, net: { amountCents: undefined, currency: undefined } });
    expect(readSettlement("capture", 10_000, "USD", settlementDetails(result.value)).state).toBe("missing");
  });

  it("retains malformed and currency-converted evidence without changing the payment status", async () => {
    const paypal = adapter({ getCapturedPayment: async () => response({
      id: "CAP-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "100.00" },
      sellerReceivableBreakdown: { grossAmount: { currencyCode: "USD", value: "100.00" }, paypalFee: { currencyCode: "EUR", value: "3.987" }, netAmount: { currencyCode: "EUR", value: "96.02" }, exchangeRate: { sourceCurrency: "USD", targetCurrency: "EUR", value: "0.90" } },
    }, 200) } as never);
    const result = await paypal.getCapture("CAP-1");
    if (result.kind !== "ok") throw new Error("Expected capture receipt");
    expect(result.value.status).toBe("COMPLETED");
    expect(result.value.settlement).toMatchObject({ fee: { amountCents: undefined, currency: "EUR" }, malformed: true, conversionPresent: true });
    expect(readSettlement("capture", 10_000, "USD", settlementDetails(result.value)).state).toBe("invalid");
  });

  it("marks platform fees unsupported rather than overlooking them in merchant net", async () => {
    const paypal = adapter({ getRefund: async () => response({
      id: "REFUND-1", amount: { currencyCode: "USD", value: "100.00" },
      sellerPayableBreakdown: { grossAmount: { currencyCode: "USD", value: "100.00" }, paypalFee: { currencyCode: "USD", value: "0.00" }, netAmount: { currencyCode: "USD", value: "99.00" }, platformFees: [{ amount: { currencyCode: "USD", value: "1.00" } }] },
    }, 200) } as never);
    const result = await paypal.getRefund("REFUND-1");
    if (result.kind !== "ok") throw new Error("Expected refund receipt");
    expect(readSettlement("refund", 10_000, "USD", settlementDetails(result.value)).state).toBe("unsupported");
  });

  it("does not turn a completed payment into a failed call when a breakdown amount is malformed", async () => {
    const paypal = adapter({ getCapturedPayment: async () => response({
      id: "CAP-1", status: "COMPLETED", amount: { currencyCode: "USD", value: "100.00" },
      sellerReceivableBreakdown: { grossAmount: { currencyCode: "USD", value: "100.00" }, paypalFee: { currencyCode: "USD", value: 398 }, netAmount: null },
    }, 200) } as never);
    const result = await paypal.getCapture("CAP-1");
    expect(result).toMatchObject({ kind: "ok", value: { status: "COMPLETED", amountCents: 10_000, settlement: { malformed: true } } });
    if (result.kind !== "ok") throw new Error("Expected capture receipt");
    expect(readSettlement("capture", 10_000, "USD", settlementDetails(result.value)).state).toBe("invalid");
  });

  it("confirms the app's order with the Sandbox test card and reads the approval back", async () => {
    let sent: unknown;
    const approve = createSdkTestCardApproval({ confirmOrder: async (request: unknown) => { sent = request; return response({ id: "ORDER-1", status: "APPROVED", purchaseUnits: [{ amount: { currencyCode: "USD", value: "800.00" }, customId: "op-1" }] }, 200); } } as never);
    const result = await approve("ORDER-1");
    expect(sent).toMatchObject({ id: "ORDER-1", body: { paymentSource: { card: { number: "4012000033330026", expiry: "2030-12" } } } });
    expect(result).toMatchObject({ kind: "ok", value: { orderId: "ORDER-1", status: "APPROVED", amountCents: 80_000, customId: "op-1" } });
  });

  it("reports a test card PayPal refuses as rejected, with its debug id", async () => {
    const refused = Object.assign(new ApiError({ request: {}, response: { statusCode: 422, headers: {}, body: "" } } as never, "Unprocessable"), {
      result: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "debug-422", details: [{ issue: "UNPROCESSABLE_ENTITY" }] },
    });
    const approve = createSdkTestCardApproval({ confirmOrder: async () => { throw refused; } } as never);
    expect(await approve("ORDER-1")).toMatchObject({ kind: "rejected", code: "UNPROCESSABLE_ENTITY", debugId: "debug-422", trace: { httpStatus: 422 } });
  });

  const checkout = { requestId: "setti-op-1-order", amountCents: 54_375, referenceId: "item-1", customId: "op-1", invoiceId: "setti-op-1", description: "Willow Residence · Chair · V2", returnUrl: "https://setti.test/return", cancelUrl: "https://setti.test/cancel" };

  it("asks PayPal to save the buyer's PayPal on success only when the checkout says so", async () => {
    const sent: { body: { paymentSource: { paypal: Record<string, unknown> } } }[] = [];
    const paypal = adapter({}, { createOrder: async (request: never) => { sent.push(request); return response({ id: "ORDER-1", status: "PAYER_ACTION_REQUIRED" }, 200); } } as never);
    await paypal.createOrder(checkout);
    await paypal.createOrder({ ...checkout, savePayPal: { description: "Setti · Willow Residence: holds for the items you approve" } });
    expect(sent[0].body.paymentSource.paypal).not.toHaveProperty("attributes");
    expect(sent[1].body.paymentSource.paypal).toMatchObject({
      experienceContext: { returnUrl: checkout.returnUrl },
      attributes: { vault: { storeInVault: "ON_SUCCESS", usageType: "MERCHANT", usagePattern: "UNSCHEDULED_POSTPAID", description: "Setti · Willow Residence: holds for the items you approve" } },
    });
  });

  it("reads whether PayPal saved the buyer's PayPal, and its token, from the order", async () => {
    const paypal = adapter({}, { authorizeOrder: async () => response({
      id: "ORDER-1", status: "COMPLETED", paymentSource: { paypal: { attributes: { vault: { id: "TOKEN-1", status: "VAULTED", customer: { id: "CUSTOMER-1" } } } } },
      purchaseUnits: [{ amount: { currencyCode: "USD", value: "543.75" }, payments: { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currencyCode: "USD", value: "543.75" } }] } }],
    }) } as never);
    const result = await paypal.authorizeOrder({ orderId: "ORDER-1", requestId: "setti-op-1" });
    expect(result).toMatchObject({ kind: "ok", value: { savedPayPal: { status: "VAULTED", tokenId: "TOKEN-1" }, authorization: { paypalAuthorizationId: "AUTH-1" } } });
  });

  it("pays a saved-PayPal order with the token as a merchant-initiated stored credential", async () => {
    let sent: unknown;
    const paypal = adapter({}, { createOrder: async (request: unknown) => { sent = request; return response({ id: "ORDER-2", status: "COMPLETED" }); } } as never);
    const { referenceId, customId, invoiceId, description } = checkout;
    await paypal.createSavedPayPalOrder({ referenceId, customId, invoiceId, description, requestId: "setti-op-2", paypalTokenId: "TOKEN-1", amountCents: 27_188 });
    expect(sent).toMatchObject({
      paypalRequestId: "setti-op-2",
      body: {
        intent: "AUTHORIZE",
        purchaseUnits: [{ amount: { currencyCode: "USD", value: "271.88" }, customId: "op-1" }],
        paymentSource: { paypal: { vaultId: "TOKEN-1", storedCredential: { paymentInitiator: "MERCHANT", usage: "SUBSEQUENT", usagePattern: "UNSCHEDULED_POSTPAID" } } },
      },
    });
    expect((sent as { body: { paymentSource: { paypal: object } } }).body.paymentSource.paypal).not.toHaveProperty("experienceContext");
  });

  it("keeps the payer-action link and return URLs for approval of the same saved-method order", async () => {
    let sent: unknown;
    const approvalUrl = "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-2";
    const paypal = adapter({}, { createOrder: async (request: unknown) => { sent = request; return response({
      id: "ORDER-2", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: approvalUrl }],
      purchaseUnits: [{ amount: { currencyCode: "USD", value: "271.88" }, customId: "op-1" }],
    }); } } as never);
    const { referenceId, customId, invoiceId, description, returnUrl, cancelUrl } = checkout;
    expect(await paypal.createSavedPayPalOrder({ referenceId, customId, invoiceId, description, returnUrl, cancelUrl,
      requestId: "setti-op-2", paypalTokenId: "TOKEN-1", amountCents: 27_188 })).toMatchObject({
      kind: "ok", value: { orderId: "ORDER-2", status: "PAYER_ACTION_REQUIRED", amountCents: 27_188, customId: "op-1", approvalUrl },
    });
    expect(sent).toMatchObject({ body: { paymentSource: { paypal: { vaultId: "TOKEN-1", experienceContext: { returnUrl, cancelUrl } } } } });
  });
});
