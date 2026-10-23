import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "./authorize";
import { chargeServices, startServicesCheckout } from "./services";
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
});
