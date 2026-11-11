import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createChatStore } from "../chat/store";
import { paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, CHAIR_CENTS, TEST_KEY } from "../projects/testing";
import { confirmScriptedChanges } from "../try/scripted-change";
import { completeAuthorization } from "./authorize";
import { startServicesCheckout } from "./services";
import { afterServicesPaid } from "./services-paid";
import { bergmund } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";
import { afterVersionConfirmed } from "./version-confirmed";

describe.skipIf(!testDatabaseUrl)("after the client confirms a version", () => {
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

  const confirmChairReplacement = () => confirmScriptedChanges(handle.db, session, TEST_KEY, [{ action: "replace", itemId: CHAIR, after: bergmund() }], { confirm: true });
  const settle = (orderId: string) => afterVersionConfirmed(handle.db, paypal, session, TEST_KEY, orderId, links);
  const messages = async () => (await createChatStore(handle.db).getCase(session, TEST_KEY)).messages;

  it("releases the old item's hold, then holds the new item with the saved method, and hands over once", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await afterServicesPaid(handle.db, paypal, session, TEST_KEY, links);

    const v2 = await confirmChairReplacement();
    const holds = await settle(v2.id);
    expect(holds).toEqual([expect.objectContaining({ status: "succeeded", amountCents: 54_375, savedMethodId: expect.any(String), approvalUrl: null })]);
    // The client's own message only: what happened to the money is in the inbox, not the chat.
    const handOff = (await messages()).at(-1)!;
    expect(handOff).toMatchObject({ id: v2.id, actor: "client", text: "I've confirmed V2. Over to you, Jordan." });
    // The old hold is released before the new one is placed, so the two are never held together.
    const operations = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.changeOrderId, v2.id));
    const release = operations.find((operation) => operation.kind === "void")!;
    const hold = operations.find((operation) => operation.kind === "authorize")!;
    expect(release).toMatchObject({ status: "succeeded", amountCents: CHAIR_CENTS });
    // Judged by the order PayPal received the calls, not by timestamps from two clocks (app and database).
    const sent = paypal.calls.map((call) => call.requestId);
    expect(sent.indexOf(release.requestId)).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf(release.requestId)).toBeLessThan(sent.indexOf(hold.requestId));

    // A retried confirmation holds nothing twice and says nothing new.
    const before = (await messages()).length;
    expect(await settle(v2.id)).toEqual([]);
    expect(await messages()).toHaveLength(before);
  });

  it("sends the client's own message with the decision, as they wrote it", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const v2 = await confirmScriptedChanges(handle.db, session, TEST_KEY, [{ action: "replace", itemId: CHAIR, after: bergmund() }], { confirm: true, note: "Thanks, Jordan. Please go ahead and order." });
    await settle(v2.id);
    expect((await messages()).find((message) => message.id === v2.id)).toMatchObject({ actor: "client", text: "Thanks, Jordan. Please go ahead and order." });
  });

  it("still hands over when no payment method is saved, leaving the holds for the client", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const v2 = await confirmChairReplacement();
    expect(await settle(v2.id)).toEqual([]);
    expect((await messages()).at(-1)).toMatchObject({ id: v2.id, actor: "client", text: "I've confirmed V2. Over to you, Jordan." });
  });
});
