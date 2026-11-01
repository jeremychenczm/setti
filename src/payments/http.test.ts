import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentActionError } from "./binding";
import { callbackState } from "./callback-state";
import { getItemHoldsResponse, getPaymentsResponse, getServicesPaymentResponse, paypalRedirectResponse, postItemHoldsResponse, postPaymentsResponse, postServicesPaymentResponse } from "./http";

const mock = vi.hoisted(() => ({
  startAuthorization: vi.fn(), startCapture: vi.fn(), startRelease: vi.fn(), startRefund: vi.fn(), checkPayment: vi.fn(), cancelPayment: vi.fn(),
  returnFromPayPal: vi.fn(), operationPage: vi.fn(), paymentsWorkspace: vi.fn(), recordSupplierOrder: vi.fn(), recordSupplierCredit: vi.fn(),
  startServicesCheckout: vi.fn(), checkServicesCheckout: vi.fn(), chargeServices: vi.fn(), lockPaymentBasis: vi.fn(), servicesPaymentView: vi.fn(), completeAuthorization: vi.fn(), cancelCheckout: vi.fn(),
  holdApprovedItems: vi.fn(), checkItemHold: vi.fn(), cancelItemHold: vi.fn(), itemHoldsView: vi.fn(), cancelApprovedItem: vi.fn(),
  paymentPreparationPending: vi.fn(),
  db: { transaction: (work: (tx: object) => unknown) => work({}) },
}));
vi.mock("./actions", () => ({
  startAuthorization: mock.startAuthorization, startCapture: mock.startCapture, startRelease: mock.startRelease, startRefund: mock.startRefund,
  checkPayment: mock.checkPayment, cancelPayment: mock.cancelPayment, returnFromPayPal: mock.returnFromPayPal, operationPage: mock.operationPage,
}));
vi.mock("./supplier", () => ({ recordSupplierOrder: mock.recordSupplierOrder, recordSupplierCredit: mock.recordSupplierCredit }));
vi.mock("./workspace", () => ({ paymentsWorkspace: mock.paymentsWorkspace }));
vi.mock("./services", () => ({ startServicesCheckout: mock.startServicesCheckout, checkServicesCheckout: mock.checkServicesCheckout, chargeServices: mock.chargeServices, lockPaymentBasis: mock.lockPaymentBasis }));
vi.mock("./services-view", () => ({ servicesPaymentView: mock.servicesPaymentView }));
vi.mock("./item-holds", () => ({ holdApprovedItems: mock.holdApprovedItems, checkItemHold: mock.checkItemHold, cancelItemHold: mock.cancelItemHold }));
vi.mock("./item-holds-view", () => ({ itemHoldsView: mock.itemHoldsView }));
vi.mock("./cancel-item", () => ({ cancelApprovedItem: mock.cancelApprovedItem }));
vi.mock("./authorize", () => ({ completeAuthorization: mock.completeAuthorization, cancelCheckout: mock.cancelCheckout }));
vi.mock("./server", () => ({ sandboxPayPal: () => ({}) }));
vi.mock("../try/preparation", () => ({ paymentPreparationPending: mock.paymentPreparationPending, PREPARATION_MESSAGE: "The starting payments are being prepared." }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: mock.db, pool: {} }) }));

const orderId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
const origin = "http://localhost:3002";
const authorize = { action: "authorize", itemId: "willow-dining-chair", side: "proposed", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };

function post(body: unknown, options: { cookie?: string | null; account?: string | null; origin?: string } = {}) {
  const account = options.account === undefined ? ((body as { action?: string }).action === "authorize" ? "sofia" : "jordan") : options.account;
  return new NextRequest(`${origin}/api/change-orders/${orderId}/payments`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: options.origin ?? origin, ...(options.cookie === null ? {} : { Cookie: [`setti-demo-chat=${options.cookie ?? sessionId}`, ...(account ? [`setti-demo-account=${account}`] : [])].join("; ") }) },
  });
}

describe("payment HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.paymentPreparationPending.mockResolvedValue(false);
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", "http-test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "http-test-secret");
    mock.paymentsWorkspace.mockResolvedValue({ orderId, projectKey: "willow", version: 3, lines: [], operations: [{ id: operationId, kind: "authorize", status: "pending" }] });
    mock.startAuthorization.mockResolvedValue({ id: operationId, status: "pending", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", paypalResourceId: null });
    mock.checkPayment.mockResolvedValue({ id: operationId });
    mock.cancelPayment.mockResolvedValue({ id: operationId });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps new Maple payment writes unavailable while prepared V1 payments are running", async () => {
    mock.paymentsWorkspace.mockResolvedValue({ orderId, projectKey: "maple", version: 2, lines: [], operations: [] });
    mock.paymentPreparationPending.mockResolvedValue(true);
    const response = await postPaymentsResponse(post(authorize, { account: "emma" }), orderId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PREPARATION_PENDING" });
    expect(mock.startAuthorization).not.toHaveBeenCalled();
  });

  it("also blocks direct V1 service and furniture checkout endpoints until preparation is ready", async () => {
    mock.paymentPreparationPending.mockResolvedValue(true);
    const services = await postServicesPaymentResponse(post({ action: "checkout" }, { account: "emma" }), "maple");
    const items = await postItemHoldsResponse(post({ action: "hold" }, { account: "emma" }), "maple");
    expect(services.status).toBe(409);
    expect(items.status).toBe(409);
    expect(await services.json()).toMatchObject({ code: "PREPARATION_PENDING" });
    expect(await items.json()).toMatchObject({ code: "PREPARATION_PENDING" });
    expect(mock.startServicesCheckout).not.toHaveBeenCalled();
    expect(mock.holdApprovedItems).not.toHaveBeenCalled();
  });

  it("keeps V1 payment views readable during preparation", async () => {
    mock.paymentPreparationPending.mockResolvedValue(true);
    mock.itemHoldsView.mockResolvedValue({ projectKey: "maple", lines: [] });
    mock.servicesPaymentView.mockResolvedValue({ projectKey: "maple", lines: [] });
    const req = new NextRequest(`${origin}/api/quotes/maple/item-holds`, { headers: { Cookie: `setti-demo-chat=${sessionId}; setti-demo-account=emma` } });
    expect((await getItemHoldsResponse(req, "maple")).status).toBe(200);
    expect((await getServicesPaymentResponse(req, "maple")).status).toBe(200);
    expect(mock.paymentPreparationPending).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1:3002", "localhost:3002"])("uses the actual %s browser authority for payment writes and PayPal callbacks", async (host) => {
    const req = post(authorize, { origin: "http://" + host });
    req.headers.set("host", host);
    const response = await postPaymentsResponse(req, orderId);
    expect(response.status).toBe(200);
    const links = mock.startAuthorization.mock.calls[0][5](operationId);
    expect(new URL(links.returnUrl).origin).toBe("http://" + host);
    expect(new URL(links.cancelUrl).origin).toBe("http://" + host);
  });

  it("rejects missing, opaque or forged payment origins before contacting PayPal", async () => {
    for (const origin of [null, "null", "http://localhost:3002", "https://attacker.example"]) {
      const req = post(authorize);
      req.headers.set("host", "127.0.0.1:3002");
      if (origin === null) req.headers.delete("origin"); else req.headers.set("origin", origin);
      req.headers.set("x-forwarded-host", "attacker.example");
      expect((await postPaymentsResponse(req, orderId)).status).toBe(403);
    }
    expect(mock.startAuthorization).not.toHaveBeenCalled();
  });

  it("serves the read-only view without a session and never starts a step without one", async () => {
    const response = await getPaymentsResponse(new NextRequest(`${origin}/api/change-orders/${orderId}/payments`), orderId);
    expect(response.status).toBe(200);
    expect(mock.paymentsWorkspace).toHaveBeenCalledWith(mock.db, null, orderId, undefined, null, expect.objectContaining({ testCard: expect.any(Boolean) }));
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

  it("upgrades the existing session and selected client before leaving for PayPal", async () => {
    const req = post(authorize, { account: "sofia" });
    const visitor = randomUUID();
    req.cookies.set("setti-try-visitor", visitor);
    const response = await postPaymentsResponse(req, orderId);
    expect(response.status).toBe(200);
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ value: sessionId, httpOnly: true, sameSite: "lax" });
    expect(response.cookies.get("setti-try-visitor")).toMatchObject({ value: visitor, httpOnly: true, sameSite: "lax" });
    expect(response.cookies.get("setti-demo-account")).toMatchObject({ value: "sofia", sameSite: "lax", httpOnly: false });
  });

  it("upgrades cookies when an old pending checkout is opened through a read-only status lookup", async () => {
    const response = await getPaymentsResponse(new NextRequest(`${origin}/api/change-orders/${orderId}/payments`, { headers: {
      Cookie: `setti-demo-chat=${sessionId}; setti-demo-account=sofia`,
    } }), orderId);
    expect(response.status).toBe(200);
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ value: sessionId, sameSite: "lax", httpOnly: true });
    expect(response.cookies.get("setti-demo-account")).toMatchObject({ value: "sofia", sameSite: "lax" });
    expect(mock.startAuthorization).not.toHaveBeenCalled();
    expect(mock.checkPayment).not.toHaveBeenCalled();
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

  it("enforces the designer role for supplier records and money execution", async () => {
    const lineRef = { itemId: "willow-dining-chair", side: "baseline", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64) };
    const actions = [
      { action: "capture", ...lineRef }, { action: "release", ...lineRef }, { action: "refund", ...lineRef },
      { action: "supplier_order", ...lineRef, quantity: 1, unitPriceCents: 100, taxCents: 0, freightCents: 0, inStock: true, leadTimeDays: 1, reference: "SUP-1", note: "" },
      { action: "supplier_credit", ...lineRef, creditCents: 100, reference: "CREDIT-1", note: "" },
    ];
    for (const action of actions) {
      for (const account of ["sofia", "emma", null]) expect((await postPaymentsResponse(post(action, { account }), orderId)).status).toBe(403);
    }
    expect(mock.startCapture).not.toHaveBeenCalled();
    expect(mock.startRelease).not.toHaveBeenCalled();
    expect(mock.startRefund).not.toHaveBeenCalled();
    expect(mock.recordSupplierOrder).not.toHaveBeenCalled();
    expect(mock.recordSupplierCredit).not.toHaveBeenCalled();
    expect((await postPaymentsResponse(post(authorize, { account: "jordan" }), orderId)).status).toBe(403);
    expect((await postPaymentsResponse(post(authorize, { account: "emma" }), orderId)).status).toBe(403);
  });

  it("allows participants to check authorization, but only the client to leave it", async () => {
    for (const account of ["jordan", "sofia"]) expect((await postPaymentsResponse(post({ action: "check", operationId }, { account }), orderId)).status).toBe(200);
    expect((await postPaymentsResponse(post({ action: "cancel", operationId }, { account: "jordan" }), orderId)).status).toBe(403);
    expect((await postPaymentsResponse(post({ action: "cancel", operationId }, { account: "sofia" }), orderId)).status).toBe(200);
    mock.paymentsWorkspace.mockResolvedValue({ orderId, projectKey: "willow", operations: [{ id: operationId, kind: "refund" }] });
    expect((await postPaymentsResponse(post({ action: "check", operationId }, { account: "sofia" }), orderId)).status).toBe(403);
    expect((await postPaymentsResponse(post({ action: "check", operationId }, { account: "jordan" }), orderId)).status).toBe(200);
    expect((await postPaymentsResponse(post({ action: "check", operationId: randomUUID() }), orderId)).status).toBe(404);
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
    mock.checkServicesCheckout.mockResolvedValue({ state: "authorized", operation: { id: operationId, paypalOrderId: "ORDER-1" } });
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

  it("lets either project participant reconcile the same service checkout", async () => {
    for (const account of ["sofia", "jordan"]) {
      const response = await postServicesPaymentResponse(services({ action: "check", operationId }, account), "willow");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operationId, paypalOrderId: "ORDER-1" });
    }
    expect(mock.checkServicesCheckout).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow", operationId, expect.any(Function));
    expect((await postServicesPaymentResponse(services({ action: "check", operationId }, "emma"), "willow")).status).toBe(403);
    mock.checkServicesCheckout.mockRejectedValueOnce(new PaymentActionError("NOT_FOUND", "Checkout not found."));
    expect((await postServicesPaymentResponse(services({ action: "check", operationId }, "sofia"), "willow")).status).toBe(404);
  });

  it("shows the payment only to accounts that can open the project", async () => {
    const get = (account: string) => getServicesPaymentResponse(new NextRequest(`${origin}/api/quotes/willow/services-payment`, { headers: { Cookie: `setti-demo-chat=${sessionId}; setti-demo-account=${account}` } }), "willow");
    expect((await get("emma")).status).toBe(403);
    expect((await get("sofia")).status).toBe(200);
    expect(mock.servicesPaymentView).toHaveBeenCalledWith(mock.db, sessionId, "willow", expect.objectContaining({ id: "sofia" }), "http-test-client", expect.objectContaining({ testCard: expect.any(Boolean) }));
  });
});

describe("item-holds HTTP boundaries", () => {
  const holds = (body: unknown, account: string | null, withSession = true) => new NextRequest(`${origin}/api/quotes/willow/item-holds`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: [...(withSession ? [`setti-demo-chat=${sessionId}`] : []), ...(account ? [`setti-demo-account=${account}`] : [])].join("; ") },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("PAYPAL_CLIENT_ID", "http-test-client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "http-test-secret");
    mock.itemHoldsView.mockResolvedValue({ projectKey: "willow", items: [] });
    mock.holdApprovedItems.mockResolvedValue([{ id: operationId }]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets the project's client or designer hold the approved items, and no one else", async () => {
    expect((await postItemHoldsResponse(holds({ action: "hold" }, "emma"), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds({ action: "hold" }, "sofia", false), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds({ action: "hold", amountCents: 1 }, "sofia"), "willow")).status).toBe(400);
    expect(mock.holdApprovedItems).not.toHaveBeenCalled();
    for (const account of ["sofia", "jordan"]) {
      const response = await postItemHoldsResponse(holds({ action: "hold" }, account), "willow");
      expect(await response.json()).toMatchObject({ attempted: 1, view: { projectKey: "willow" } });
    }
    expect(mock.holdApprovedItems).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow", expect.any(Function));
    const get = await getItemHoldsResponse(new NextRequest(`${origin}/api/quotes/willow/item-holds`, { headers: { Cookie: `setti-demo-chat=${sessionId}; setti-demo-account=emma` } }), "willow");
    expect(get.status).toBe(403);
  });

  it("checks saved holds for either participant and only lets the client leave checkout", async () => {
    for (const account of ["sofia", "jordan"]) expect((await postItemHoldsResponse(holds({ action: "check", operationId }, account), "willow")).status).toBe(200);
    expect(mock.checkItemHold).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow", operationId, expect.any(Function));
    expect((await postItemHoldsResponse(holds({ action: "check", operationId }, "emma"), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds({ action: "cancel", operationId }, "jordan"), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds({ action: "cancel", operationId }, "sofia"), "willow")).status).toBe(200);
    expect(mock.cancelItemHold).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow", operationId);
  });

  it("lets only the designer cancel an item, with a reason from the list", async () => {
    mock.cancelApprovedItem.mockResolvedValue({ cancellation: { id: "c" }, operations: [{ id: operationId }] });
    const body = { action: "cancel_item", itemId: "willow-desk", reason: "no_response", note: "  Three emails, no answer.  " };
    expect((await postItemHoldsResponse(holds(body, "sofia"), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds(body, "jordan", false), "willow")).status).toBe(403);
    expect((await postItemHoldsResponse(holds({ ...body, reason: "too_expensive" }, "jordan"), "willow")).status).toBe(400);
    expect((await postItemHoldsResponse(holds({ ...body, amountCents: 1 }, "jordan"), "willow")).status).toBe(400);
    expect(mock.cancelApprovedItem).not.toHaveBeenCalled();
    const response = await postItemHoldsResponse(holds(body, "jordan"), "willow");
    expect(await response.json()).toMatchObject({ attempted: 1, view: { projectKey: "willow" } });
    expect(mock.cancelApprovedItem).toHaveBeenCalledWith(mock.db, {}, sessionId, "willow", { action: "cancel_item", itemId: "willow-desk", reason: "no_response", note: "Three emails, no answer.", by: "Jordan Lee" });
  });
});
