import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentActionError } from "./binding";
import { callbackState } from "./callback-state";
import { getPaymentsResponse, getServicesPaymentResponse, paypalRedirectResponse, postPaymentsResponse, postServicesPaymentResponse } from "./http";

const mock = vi.hoisted(() => ({
  startAuthorization: vi.fn(), startCapture: vi.fn(), startRelease: vi.fn(), startRefund: vi.fn(), checkPayment: vi.fn(), cancelPayment: vi.fn(),
  returnFromPayPal: vi.fn(), operationPage: vi.fn(), paymentsWorkspace: vi.fn(), recordSupplierOrder: vi.fn(), recordSupplierCredit: vi.fn(),
  startServicesCheckout: vi.fn(), chargeServices: vi.fn(), lockPaymentBasis: vi.fn(), servicesPaymentView: vi.fn(), completeAuthorization: vi.fn(), cancelCheckout: vi.fn(),
  db: { transaction: (work: (tx: object) => unknown) => work({}) },
}));
vi.mock("./actions", () => ({
  startAuthorization: mock.startAuthorization, startCapture: mock.startCapture, startRelease: mock.startRelease, startRefund: mock.startRefund,
  checkPayment: mock.checkPayment, cancelPayment: mock.cancelPayment, returnFromPayPal: mock.returnFromPayPal, operationPage: mock.operationPage,
}));
vi.mock("./supplier", () => ({ recordSupplierOrder: mock.recordSupplierOrder, recordSupplierCredit: mock.recordSupplierCredit }));
vi.mock("./workspace", () => ({ paymentsWorkspace: mock.paymentsWorkspace }));
vi.mock("./services", () => ({ startServicesCheckout: mock.startServicesCheckout, chargeServices: mock.chargeServices, lockPaymentBasis: mock.lockPaymentBasis }));
vi.mock("./services-view", () => ({ servicesPaymentView: mock.servicesPaymentView }));
vi.mock("./authorize", () => ({ completeAuthorization: mock.completeAuthorization, cancelCheckout: mock.cancelCheckout }));
vi.mock("./server", () => ({ sandboxPayPal: () => ({}) }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: mock.db, pool: {} }) }));

const orderId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
const origin = "http://localhost:3002";
const authorize = { action: "authorize", itemId: "willow-dining-chair", side: "proposed", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };

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
    expect(mock.paymentsWorkspace).toHaveBeenCalledWith(mock.db, null, orderId);
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
    expect([session, id, input.itemId]).toEqual([sessionId, orderId, "willow-dining-chair"]);
    expect(links(operationId)).toEqual({ returnUrl: `${origin}/api/payments/paypal/return?op=${operationId}&state=${callbackState(operationId, "return")}`, cancelUrl: `${origin}/api/payments/paypal/cancel?op=${operationId}&state=${callbackState(operationId, "cancel")}` });
  });

  it("routes designer steps without accepting any client-supplied amount", async () => {
    mock.startCapture.mockResolvedValue([{ id: operationId }]);
    const lineRef = { itemId: "willow-dining-chair", side: "baseline", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };
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
    mock.operationPage.mockResolvedValue({ path: `/change-orders/${orderId}`, anchor: "payments", projectKey: "willow" });
    mock.returnFromPayPal.mockResolvedValue({ orderId, state: "authorized" });
    const back = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&PayerID=X&state=${callbackState(operationId, "return")}`), "return");
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=authorized#payments`);
    expect(mock.returnFromPayPal).toHaveBeenCalledWith(mock.db, {}, operationId, "ORDER-1", "return");

    mock.returnFromPayPal.mockResolvedValue(null);
    const unmatched = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/cancel?op=${operationId}&token=OTHER&state=${callbackState(operationId, "cancel")}`), "cancel");
    expect(unmatched.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unmatched#payments`);

    mock.returnFromPayPal.mockRejectedValue(new Error("database unavailable"));
    const failed = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&state=${callbackState(operationId, "return")}`), "return");
    expect(failed.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unknown#payments`);
  });

  it("sends a returning client to the quote and charges the design services they approved", async () => {
    mock.operationPage.mockResolvedValue({ path: "/quotes/willow", anchor: "design-services", projectKey: "willow" });
    mock.returnFromPayPal.mockResolvedValue({ orderId: null, servicesHold: true, state: "authorized" });
    mock.chargeServices.mockResolvedValue([]);
    const back = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&state=${callbackState(operationId, "return")}`, { headers: { Cookie: `setti-demo-chat=${sessionId}` } }), "return");
    expect(back.headers.get("location")).toBe(`${origin}/quotes/willow?paypal=authorized#design-services`);
    expect(mock.chargeServices).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow");
  });

  it("refuses callbacks reconstructed from the public operation and order ids", async () => {
    for (const state of ["", "&state=untrusted", `&state=${callbackState(operationId, "return")}`]) {
      const response = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/cancel?op=${operationId}&token=ORDER-1${state}`), "cancel");
      expect(response.headers.get("location")).toBe(`${origin}/`);
    }
    expect(mock.returnFromPayPal).not.toHaveBeenCalled();
    expect(mock.operationPage).not.toHaveBeenCalled();
  });
});

describe("design-services payment HTTP boundaries", () => {
  const services = (body: unknown, account: string | null, key = "willow") => new NextRequest(`${origin}/api/quotes/${key}/services-payment`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: [`setti-demo-chat=${sessionId}`, ...(account ? [`setti-demo-account=${account}`] : [])].join("; ") },
  });
  const view = { projectKey: "willow", canPay: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", "http-test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "http-test-secret");
    mock.servicesPaymentView.mockResolvedValue(view);
    mock.startServicesCheckout.mockResolvedValue({ id: operationId, status: "pending", paypalOrderId: "ORDER-1", paypalResourceId: null });
    mock.lockPaymentBasis.mockResolvedValue({ ledger: { operations: [{ id: operationId, servicesHold: true }] } });
    mock.completeAuthorization.mockResolvedValue({ state: "authorized" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets only the project's client start the PayPal checkout, and returns PayPal's order id", async () => {
    expect((await postServicesPaymentResponse(services({ action: "checkout" }, "jordan"), "willow")).status).toBe(403);
    expect((await postServicesPaymentResponse(services({ action: "checkout" }, "emma"), "willow")).status).toBe(403);
    expect(mock.startServicesCheckout).not.toHaveBeenCalled();
    const response = await postServicesPaymentResponse(services({ action: "checkout" }, "sofia"), "willow");
    expect(await response.json()).toMatchObject({ operationId, paypalOrderId: "ORDER-1", view });
    expect(mock.startServicesCheckout.mock.calls[0].slice(2, 4)).toEqual([sessionId, "willow"]);
  });

  it("charges the services once PayPal confirms the client's approval", async () => {
    await postServicesPaymentResponse(services({ action: "approve", operationId }, "sofia"), "willow");
    expect(mock.completeAuthorization).toHaveBeenCalledWith(mock.db, {}, operationId);
    expect(mock.chargeServices).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow");

    mock.lockPaymentBasis.mockResolvedValue({ ledger: { operations: [] } });
    expect((await postServicesPaymentResponse(services({ action: "approve", operationId }, "sofia"), "willow")).status).toBe(404);
  });

  it("lets the designer finish charging a hold the client approved, but not start one", async () => {
    expect((await postServicesPaymentResponse(services({ action: "charge" }, "jordan"), "willow")).status).toBe(200);
    expect((await postServicesPaymentResponse(services({ action: "approve", operationId }, "jordan"), "willow")).status).toBe(403);
    expect((await postServicesPaymentResponse(services({ action: "checkout", amountCents: 1 }, "sofia"), "willow")).status).toBe(400);
  });

  it("shows the payment only to accounts that can open the project", async () => {
    const get = (account: string) => getServicesPaymentResponse(new NextRequest(`${origin}/api/quotes/willow/services-payment`, { headers: { Cookie: `setti-demo-chat=${sessionId}; setti-demo-account=${account}` } }), "willow");
    expect((await get("emma")).status).toBe(403);
    expect((await get("sofia")).status).toBe(200);
    expect(mock.servicesPaymentView).toHaveBeenCalledWith(mock.db, sessionId, "willow", expect.objectContaining({ id: "sofia" }), "http-test-client");
  });
});
