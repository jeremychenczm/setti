import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "./authorize";
import { chargeServices, checkServicesCheckout, startServicesCheckout } from "./services";
import { servicesPaymentView } from "./services-view";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer, client, otherClient] = DEMO_ACCOUNTS;
const CLIENT_ID = "sandbox-client-id";

describe.skipIf(!testDatabaseUrl)("design-services payment view", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());
  afterEach(() => vi.restoreAllMocks());

  const view = (account = client, sessionId: string | null = session) => servicesPaymentView(handle.db, sessionId, "willow", account, CLIENT_ID);
  const signAll = () => signOpeningForTest(handle.db, session, "willow");

  it("lets only the project's client pay the approved design services of V1", async () => {
    await signAll();
    const forClient = await view();
    expect(forClient).toMatchObject({ basis: { version: 1, orderId: null }, dueCents: 453_000, canPay: true, canFinish: false, savedPayPal: false, paypalClientId: CLIENT_ID, reason: null });
    expect(forClient.services.map((line) => [line.label, line.targetCents])).toContainEqual(["Design consultation", 30_000]);
    expect(forClient.services).toHaveLength(6);

    for (const account of [designer, otherClient]) {
      expect(await view(account)).toMatchObject({ canPay: false, paypalClientId: null, reason: expect.stringMatching(/client pays from their own account/) });
    }
    expect(await view(client, null)).toMatchObject({ basis: null, canPay: false });
    expect(await view(client, randomUUID())).toMatchObject({ basis: null, canPay: false });
  });

  it("offers to finish charging a held payment, then shows each service captured", async () => {
    await signAll();
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    expect(await view()).toMatchObject({ canPay: true, checkout: { operationId: checkout.id, status: "pending", paypalOrderId: checkout.paypalOrderId, authorized: false } });
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    expect(await view()).toMatchObject({ canPay: false, canFinish: true, savedPayPal: true, checkout: { authorized: true } });

    await chargeServices(handle.db, paypal, session, "willow");
    const paid = await view();
    expect(paid).toMatchObject({ dueCents: 0, canPay: false, canFinish: false, reason: null });
    expect(paid.services.every((line) => line.capturedCents === line.targetCents && line.captures.length === 1 && line.captures[0].status === "completed")).toBe(true);
    expect(paid.services[0].captures[0].settlement.state).toBe("missing"); // the fake reports no seller breakdown
  });

  it("explains that payment waits for an approved design service", async () => {
    const desk = caseDocument("willow").lines.find((line) => line.category === "furniture")!;
    await signOpeningForTest(handle.db, session, "willow", [{ itemId: desk.itemId, decision: "approved" }]);
    expect(await view()).toMatchObject({ services: [], dueCents: 0, canPay: false, reason: expect.stringMatching(/has not approved a design service/) });
  });

  it("recovers a lost create response on V1 without creating a replacement checkout", async () => {
    await signAll();
    paypal.then("lose-response");
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    expect(checkout).toMatchObject({ status: "unknown", paypalOrderId: null });
    expect(await view()).toMatchObject({ canPay: false, canCheck: true, canFinish: false, checkout: { operationId: checkout.id, approvalUrl: null } });
    expect(await view(designer)).toMatchObject({ canCheck: true });
    expect(await view(otherClient)).toMatchObject({ canCheck: false, canFinish: false });

    const recovered = await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links);
    expect(recovered).toMatchObject({ state: "awaiting_buyer", operation: { id: checkout.id, status: "pending" } });
    expect(await view()).toMatchObject({ canPay: true, canCheck: true, checkout: { operationId: checkout.id, approvalUrl: expect.stringContaining(recovered.operation.paypalOrderId!) } });
    expect((await view(designer)).checkout?.approvalUrl).toBeNull();
    const createCalls = paypal.calls.filter((call) => "returnUrl" in call);
    expect(createCalls).toHaveLength(2);
    expect(new Set(createCalls.map((call) => call.requestId)).size).toBe(1);

    paypal.approve(recovered.operation.paypalOrderId!);
    await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links);
    expect(await view()).toMatchObject({ dueCents: 0, canCheck: false, canPay: false });
    const writes = paypal.calls.length;
    await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links);
    expect(paypal.calls).toHaveLength(writes);
  });

  it("finds an authorization whose answer was lost and captures each service only once", async () => {
    await signAll();
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    paypal.then("lose-response");
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("unknown");
    expect(await view()).toMatchObject({ canPay: false, canFinish: false, canCheck: true });
    expect((await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links)).state).toBe("authorized");
    const paid = await view();
    expect(paid).toMatchObject({ dueCents: 0, canCheck: false });
    expect(paid.services).toHaveLength(6);
    expect(paid.services.every((line) => line.captures.length === 1)).toBe(true);
    expect(paypal.calls.filter((call) => "orderId" in call)).toHaveLength(1);
    await expect(checkServicesCheckout(handle.db, paypal, randomUUID(), "willow", checkout.id, links)).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    await expect(checkServicesCheckout(handle.db, paypal, session, "willow", randomUUID(), links)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only offers a status check while PayPal is reviewing the authorization", async () => {
    await signAll();
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    paypal.then("answer-pending");
    await completeAuthorization(handle.db, paypal, checkout.id);
    expect(await view()).toMatchObject({ canPay: false, canCheck: true, canFinish: false, checkout: { approvalUrl: null }, reason: expect.stringContaining("reviewing") });
  });

  it("reconciles pending service captures without offering or creating another payment", async () => {
    await signAll();
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    paypal.then("answer-pending");
    await chargeServices(handle.db, paypal, session, "willow");
    expect(await view()).toMatchObject({ canPay: false, canCheck: true, reason: expect.stringContaining("processing") });
    const writes = paypal.calls.length;
    await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links);
    expect(paypal.calls).toHaveLength(writes);
    expect(await view()).toMatchObject({ canPay: false, canCheck: true });

    const getCapture = paypal.getCapture.bind(paypal);
    vi.spyOn(paypal, "getCapture").mockImplementation(async (id) => {
      const result = await getCapture(id);
      return result.kind === "ok" ? { ...result, value: { ...result.value, status: "COMPLETED" } } : result;
    });
    await checkServicesCheckout(handle.db, paypal, session, "willow", checkout.id, links);
    expect(paypal.calls).toHaveLength(writes);
    expect(await view()).toMatchObject({ dueCents: 0, canPay: false, canCheck: false });
  });
});
