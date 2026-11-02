import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createChatStore } from "../chat/store";
import { paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
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
  });
  afterAll(() => handle?.pool.end());

  const confirmChairReplacement = () => confirmScriptedChanges(handle.db, session, "willow", [{ action: "replace", itemId: CHAIR, after: bergmund() }], { confirm: true });
  const settle = (orderId: string) => afterVersionConfirmed(handle.db, paypal, session, "willow", orderId, links);
  const messages = async () => (await createChatStore(handle.db).getCase(session, "willow")).messages;

  it("releases the old item's hold, then holds the new item with the saved method, and hands over once", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await afterServicesPaid(handle.db, paypal, session, "willow", links);

    const v2 = await confirmChairReplacement();
    const holds = await settle(v2.id);
    expect(holds).toEqual([expect.objectContaining({ status: "succeeded", amountCents: 54_375, savedMethodId: expect.any(String), approvalUrl: null })]);
    const handOff = (await messages()).at(-1)!;
    expect(handOff).toMatchObject({ id: v2.id, actor: "client" });
    expect(handOff.text).toBe("I've confirmed V2. The $348.00 held for the item I no longer need is released. 1 furniture item is held on my PayPal ($543.75), to be charged as each supplier confirms. Over to you, Jordan.");
    // The old hold is released before the new one is placed, so the two are never held together.
    const operations = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.changeOrderId, v2.id));
    const release = operations.find((operation) => operation.kind === "void")!;
    const hold = operations.find((operation) => operation.kind === "authorize")!;
    expect(release).toMatchObject({ status: "succeeded", amountCents: 34_800 });
    expect(release.updatedAt.getTime()).toBeLessThanOrEqual(hold.createdAt.getTime());

    // A retried confirmation holds nothing twice and says nothing new.
    const before = (await messages()).length;
    expect(await settle(v2.id)).toEqual([]);
    expect(await messages()).toHaveLength(before);
  });

  it("still hands over when no payment method is saved, leaving the holds for the client", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const v2 = await confirmChairReplacement();
    expect(await settle(v2.id)).toEqual([]);
    expect((await messages()).at(-1)).toMatchObject({ id: v2.id, actor: "client", text: "I've confirmed V2. Over to you, Jordan." });
  });
});
