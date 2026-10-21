import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentActionError } from "./binding";
import { getPaymentsResponse, paypalRedirectResponse, postPaymentsResponse } from "./http";

const mock = vi.hoisted(() => ({
  startAuthorization: vi.fn(), checkPayment: vi.fn(), cancelPayment: vi.fn(), returnFromPayPal: vi.fn(), operationChangeOrder: vi.fn(), paymentsWorkspace: vi.fn(),
}));
vi.mock("./actions", () => ({ startAuthorization: mock.startAuthorization, checkPayment: mock.checkPayment, cancelPayment: mock.cancelPayment, returnFromPayPal: mock.returnFromPayPal, operationChangeOrder: mock.operationChangeOrder }));
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
    mock.paymentsWorkspace.mockResolvedValue({ orderId, version: 3, lines: [], operations: [] });
    mock.startAuthorization.mockResolvedValue({ id: operationId, status: "pending", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1", paypalResourceId: null });
  });

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
    expect(links(operationId)).toEqual({ returnUrl: `${origin}/api/payments/paypal/return?op=${operationId}`, cancelUrl: `${origin}/api/payments/paypal/cancel?op=${operationId}` });
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
    const back = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1&PayerID=X`), "return");
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=authorized#payments`);
    expect(mock.returnFromPayPal).toHaveBeenCalledWith({}, {}, operationId, "ORDER-1", "return");

    mock.returnFromPayPal.mockResolvedValue(null);
    const unmatched = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/cancel?op=${operationId}&token=OTHER`), "cancel");
    expect(unmatched.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unmatched#payments`);

    mock.returnFromPayPal.mockRejectedValue(new Error("database unavailable"));
    const failed = await paypalRedirectResponse(new NextRequest(`${origin}/api/payments/paypal/return?op=${operationId}&token=ORDER-1`), "return");
    expect(failed.headers.get("location")).toBe(`${origin}/change-orders/${orderId}?paypal=unknown#payments`);
  });
});
