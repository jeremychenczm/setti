import { randomUUID } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, FURNITURE_CENTS, TEST_KEY, testClient } from "../projects/testing";
import { completeAuthorization } from "./authorize";
import { itemHoldsView } from "./item-holds-view";
import { startServicesCheckout } from "./services";
import { afterServicesPaid } from "./services-paid";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

describe.skipIf(!testDatabaseUrl)("after the client pays the design services", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
  });
  afterAll(() => handle?.pool.end());

  const settle = () => afterServicesPaid(handle.db, paypal, session, TEST_KEY, links);
  const clientMessages = async () => (await createChatStore(handle.db).getCase(session, TEST_KEY)).messages.filter((message) => message.actor === "client");

  async function payServices(save = true) {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links, { save });
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    return checkout;
  }

  it("captures each service, holds every approved furniture item with the saved method, and hands over once", async () => {
    const checkout = await payServices();
    const { captures, holds } = await settle();
    expect(captures).toHaveLength(2);
    expect(holds).toHaveLength(4);
    expect([...captures, ...holds].every((operation) => operation.status === "succeeded")).toBe(true);
    expect(holds.every((operation) => operation.savedMethodId && operation.approvalUrl === null)).toBe(true);
    expect((await itemHoldsView(handle.db, session, TEST_KEY, testClient)).items.every((item) => item.state === "held")).toBe(true);

    const [handOff] = await clientMessages();
    expect(handOff).toMatchObject({ id: checkout.id, aiState: "none", model: null });
    expect(handOff.text).toBe("I've signed quote V1 and paid the design services ($800.00). 4 items are held on my PayPal ($1,822.60), to be charged as each supplier confirms. Over to you, Jordan.");
    expect((await createChatStore(handle.db).getCase(session, TEST_KEY)).messages.at(-1)?.id).toBe(checkout.id);

    // A repeated settle finds nothing left to charge or hold, and says nothing new.
    const holdsBefore = (await handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId))).length;
    expect(await settle()).toEqual({ captures: [], holds: [] });
    expect((await handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId))).length).toBe(holdsBefore);
    expect(await clientMessages()).toHaveLength(1);
  });

  it("leaves the furniture for the client to hold when the payment method was not saved", async () => {
    await payServices(false);
    expect((await settle()).holds).toEqual([]);
    expect((await itemHoldsView(handle.db, session, TEST_KEY, testClient)).items.every((item) => item.state === "to_hold")).toBe(true);
    expect((await clientMessages())[0].text).toBe("I've signed quote V1 and paid the design services ($800.00). Over to you, Jordan.");
  });

  it("counts only the holds PayPal confirmed and says the rest are still open", async () => {
    await payServices();
    // The two service captures succeed; the first furniture hold needs the client on PayPal.
    paypal.then("succeed", "succeed", "answer-payer-action");
    const { holds } = await settle();
    const open = holds.filter((operation) => operation.status !== "succeeded");
    expect(open).toHaveLength(1);
    expect((await clientMessages())[0].text).toContain(`3 of 4 items are held on my PayPal (${usd(FURNITURE_CENTS - open[0].amountCents)}); the rest still need a hold.`);
  });
});
