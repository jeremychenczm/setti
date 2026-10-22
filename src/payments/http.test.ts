import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentActionError } from "./binding";
import { callbackState } from "./callback-state";
import { getPaymentsResponse, paypalRedirectResponse, postPaymentsResponse } from "./http";

const mock = vi.hoisted(() => ({
  startAuthorization: vi.fn(), startCapture: vi.fn(), startRelease: vi.fn(), startRefund: vi.fn(), checkPayment: vi.fn(), cancelPayment: vi.fn(),
  returnFromPayPal: vi.fn(), operationChangeOrder: vi.fn(), paymentsWorkspace: vi.fn(), recordSupplierOrder: vi.fn(), recordSupplierCredit: vi.fn(),
}));
vi.mock("./actions", () => ({
  startAuthorization: mock.startAuthorization, startCapture: mock.startCapture, startRelease: mock.startRelease, startRefund: mock.startRefund,
  checkPayment: mock.checkPayment, cancelPayment: mock.cancelPayment, returnFromPayPal: mock.returnFromPayPal, operationChangeOrder: mock.operationChangeOrder,
}));
vi.mock("./supplier", () => ({ recordSupplierOrder: mock.recordSupplierOrder, recordSupplierCredit: mock.recordSupplierCredit }));
vi.mock("./workspace", () => ({ paymentsWorkspace: mock.paymentsWorkspace }));
vi.mock("./server", () => ({ sandboxPayPal: () => ({}) }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

const orderId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
const origin = "http://localhost:3002";
const authorize = { action: "authorize", itemId: "willow-lisabo-dining-chair", side: "proposed", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };

function post(body: unknown, options: { cookie?: string | null; origin?: string } = {}) {
  return new NextRequest(`${origin}/api/change-orders/${orderId}/payments`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: options.origin ?? origin, ...(options.cookie === null ? {} : { Cookie: `setti-demo-chat=${options.cookie ?? sessionId}` }) },
  });
}

describe("payment HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", "http-test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "http-test-secret");
    mock.paymentsWorkspace.mockResolvedValue({ orderId, version: 3, lines: [], operations: [] });
    mock.startAuthorization.mockResolvedValue({ id: operationId, status: "pending", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", paypalResourceId: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("serves the read-only view without a session and never starts a step without one", async () => {
    const response = await getPaymentsResponse(new NextRequest(`${origin}/api/change-orders/${orderId}/payments`), orderId);
    expect(response.status).toBe(200);
    expect(mock.paymentsWorkspace).toHaveBeenCalledWith({}, null, orderId);
    expect((await postPaymentsResponse(post(authorize, { cookie: null }), orderId)).status).toBe(403);
    expect(mock.startAuthorization).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests and malformed or client-priced bodies", async () => {
    expect((await postPaymentsResponse(post(authorize, { origin: "https://evil.example" }), orderId)).status).toBe(403);
    expect((await postPaymentsResponse(post({ ...authorize, amountCents: 1 }), orderId)).status).toBe(400);
    expect((await postPaymentsResponse(post({ ...authorize, side: "elsewhere" }), orderId)).status).toBe(400);
    expect(mock.startAuthorization).not.toHaveBeenCalled();
  });

  it("starts an authorization with the server-built PayPal links and returns the approval link", async () => {
    const response = await postPaymentsResponse(post(authorize), orderId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operationId, redirectUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" });
    const [, , session, id, input, links] = mock.startAuthorization.mock.calls[0];
    expect([session, id, input.itemId]).toEqual([sessionId, orderId, "willow-lisabo-dining-chair"]);
    expect(links(operationId)).toEqual({ returnUrl: `${origin}/api/payments/paypal/return?op=${operationId}&state=${callbackState(operationId, "return")}`, cancelUrl: `${origin}/api/payments/paypal/cancel?op=${operationId}&state=${callbackState(operationId, "cancel")}` });
  });

  it("routes designer steps without accepting any client-supplied amount", async () => {
    mock.startCapture.mockResolvedValue([{ id: operationId }]);
    const lineRef = { itemId: "willow-lisabo-dining-chair", side: "baseline", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };
    expect(await (await postPaymentsResponse(post({ action: "capture", ...lineRef }), orderId)).json()).toMatchObject({ operationId, redirectUrl: null });
    expect((await postPaymentsResponse(post({ action: "capture", ...lineRef, amountCents: 81_563 }), orderId)).status).toBe(400);
    expect((await postPaymentsResponse(post({ action: "refund", ...lineRef, amountCents: 79_063 }), orderId)).status).toBe(400);
    const order = { action: "supplier_order", ...lineRef, quantity: 6, unitPriceCents: 12_500, taxCents: 6_563, freightCents: 0, inStock: true, leadTimeDays: 10, reference: "DEMO-SUPPLIER-1", note: "" };
    expect((await postPaymentsResponse(post(order), orderId)).status).toBe(200);
    expect(mock.recordSupplierOrder.mock.calls[0][3]).toMatchObject({ quantity: 6, reference: "DEMO-SUPPLIER-1" });
    expect((await postPaymentsResponse(post({ ...order, reference: " " }), orderId)).status).toBe(400);
    expect((await postPaymentsResponse(post({ action: "release", ...lineRef }, { cookie: null }), orderId)).status).toBe(403);
  });

  it("maps refusals to conflicts with their reasons", async () => {
    mock.startAuthorization.mockRejectedValue(new PaymentActionError("STALE_VERSION", "A newer client-confirmed version replaced V3."));
    const response = await postPaymentsResponse(post(authorize), orderId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_VERSION" });
  });

  it("sends the returning buyer to the change order with the outcome PayPal reported", async () => {
    mock.operationChangeOrder.mockResolvedValue(orderId);
    mock.returnFromPayPal.mockResolvedValue({ orderId, state: "authorized" });
    const back = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&PayerID=X&state=${callbackState(operationId, "return")}`), "return");
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=authorized#payments`);
    expect(mock.returnFromPayPal).toHaveBeenCalledWith({}, {}, operationId, "ORDER-1", "return");

    mock.returnFromPayPal.mockResolvedValue(null);
    const unmatched = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/cancel?op=${operationId}&token=OTHER&state=${callbackState(operationId, "cancel")}`), "cancel");
    expect(unmatched.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unmatched#payments`);

    mock.returnFromPayPal.mockRejectedValue(new Error("database unavailable"));
    const failed = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&state=${callbackState(operationId, "return")}`), "return");
    expect(failed.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unknown#payments`);
  });

  it("refuses callbacks reconstructed from the public operation and order ids", async () => {
    for (const state of ["", "&state=untrusted", `&state=${callbackState(operationId, "return")}`]) {
      const response = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/cancel?op=${operationId}&token=ORDER-1${state}`), "cancel");
      expect(response.headers.get("location")).toBe(`${origin}/`);
    }
    expect(mock.returnFromPayPal).not.toHaveBeenCalled();
    expect(mock.operationChangeOrder).not.toHaveBeenCalled();
  });
});
