import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { paymentOperations, paypalAuthorizations, paypalCalls } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { cancelPayment, checkPayment, returnFromPayPal, startAuthorization } from "./actions";
import { bergmund, confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { paymentsWorkspace } from "./workspace";

const CHAIR = "willow-lisabo-dining-chair";
const links = (operationId: string) => ({ returnUrl: `http://localhost:3002/api/payments/paypal/return?op=${operationId}`, cancelUrl: `http://localhost:3002/api/payments/paypal/cancel?op=${operationId}` });

describe.skipIf(!testDatabaseUrl)("initial authorization of a confirmed line", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v2: FrozenChangeOrder;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    v2 = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
  });
  afterAll(() => handle?.pool.end());

  const start = (order = v2, sessionId = session) => startAuthorization(handle.db, paypal, sessionId, order.id, { itemId: CHAIR, side: "proposed", ...shown(order) }, links);
  const holds = () => handle.db.select().from(paypalAuthorizations);
  const back = (operationId: string, orderId: string | null, outcome: "return" | "cancel" = "return") => returnFromPayPal(handle.db, paypal, operationId, orderId, outcome);

  it("holds exactly the confirmed $543.75 chair line after the buyer approves on PayPal", async () => {
    const checkout = await start();
    expect(checkout).toMatchObject({ kind: "authorize", status: "pending", amountCents: 54_375, changeOrderId: v2.id, contentHash: v2.contentHash, revisionContentHash: v2.revisionContentHash });
    expect(checkout.approvalUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    expect(paypal.calls[0]).toMatchObject({ amountCents: 54_375, customId: checkout.id, returnUrl: links(checkout.id).returnUrl });

    paypal.approve(checkout.paypalOrderId!);
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "authorized" });
    const [hold] = await holds();
    expect(hold).toMatchObject({ amountCents: 54_375, currency: "USD", status: "created", paypalOrderId: checkout.paypalOrderId, changeOrderId: v2.id, operationId: checkout.id, itemId: checkout.itemId });
    expect(hold.expiresAt).toBeTruthy();
    expect(hold.honorExpiresAt!.getTime() - hold.createdAt.getTime()).toBeLessThan(4 * 86_400_000);

    const workspace = (await paymentsWorkspace(handle.db, session, v2.id))!;
    const chair = workspace.lines.find((line) => line.itemId === CHAIR && line.side === "proposed")!;
    expect(chair).toMatchObject({ targetCents: 54_375, heldCents: 54_375, capturedCents: 0, refundedCents: 0, holds: [{ paypalAuthorizationId: hold.paypalAuthorizationId, version: v2.version, status: "created" }] });
    expect(chair.steps).toEqual([expect.objectContaining({ kind: "capture", amountCents: 54_375, available: false })]);
    expect(workspace.plan?.money.newAuthorizationCents).toBeGreaterThan(0); // the other, unchanged furniture lines are not funded
    expect(workspace.others.lineCount).toBe(v2.lines.length - 1);
    expect(workspace.operations[0]).toMatchObject({ status: "succeeded", paypalResourceId: hold.paypalAuthorizationId, approvalUrl: null });
    expect(workspace.operations[0].calls.map((call) => call.step)).toEqual(["authorize_order", "get_order", "create_order"]);
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.at(-1)?.text).toMatch(/authorization recorded for V2 .*543\.75 USD is held.*Nothing has been charged/);
  });

  it("returns the same checkout for repeated clicks and a second window", async () => {
    const [first, second] = await Promise.all([start(), start()]);
    const third = await start();
    expect(new Set([first.id, second.id, third.id]).size).toBe(1);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
    expect(new Set([first.paypalOrderId, second.paypalOrderId, third.paypalOrderId]).size).toBe(1);
  });

  it("treats the browser coming back as no proof: unapproved checkouts keep waiting and foreign tokens are ignored", async () => {
    const checkout = await start();
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "awaiting_buyer" });
    expect(await back(checkout.id, "SOME-OTHER-ORDER")).toBeNull();
    expect(await back(checkout.id, null)).toBeNull();
    expect(await holds()).toHaveLength(0);
    paypal.approve(checkout.paypalOrderId!);
    // The approval arrives, the callback is lost; checking from the page finds it on PayPal.
    expect((await checkPayment(handle.db, paypal, session, v2.id, checkout.id, links)).status).toBe("succeeded");
    expect(await holds()).toHaveLength(1);
  });

  it("records no authorization when the client cancels on PayPal, and a new attempt is a new operation", async () => {
    const checkout = await start();
    expect(await back(checkout.id, checkout.paypalOrderId, "cancel")).toEqual({ orderId: v2.id, state: "failed" });
    const [cancelled] = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.id, checkout.id));
    expect(cancelled).toMatchObject({ status: "failed", failureCode: "BUYER_CANCELLED" });
    expect(await holds()).toHaveLength(0);
    const retry = await start();
    expect(retry.id).not.toBe(checkout.id);
    expect(retry.businessKey).toMatch(/:2$/);
  });

  it("keeps an approval that arrives with a cancel: PayPal is asked before anything is dropped", async () => {
    const checkout = await start();
    paypal.approve(checkout.paypalOrderId!);
    expect((await cancelPayment(handle.db, paypal, session, v2.id, checkout.id)).status).toBe("succeeded");
    expect(await holds()).toHaveLength(1);
  });

  it("recovers a lost authorize response by reading the order back, recording the hold once", async () => {
    const checkout = await start();
    paypal.approve(checkout.paypalOrderId!);
    paypal.then("lose-response");
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "unknown" });
    expect(await holds()).toHaveLength(0);
    expect((await paymentsWorkspace(handle.db, session, v2.id))!.plan?.status).toBe("blocked");
    expect((await checkPayment(handle.db, paypal, session, v2.id, checkout.id, links)).status).toBe("succeeded");
    expect((await checkPayment(handle.db, paypal, session, v2.id, checkout.id, links)).status).toBe("succeeded");
    expect(await holds()).toHaveLength(1);
  });

  it("stops for reconciliation when PayPal authorizes a different amount", async () => {
    const checkout = await start();
    paypal.approve(checkout.paypalOrderId!);
    paypal.then("answer-other-amount");
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "unknown" });
    const [stopped] = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.id, checkout.id));
    expect(stopped).toMatchObject({ status: "unknown", failureCode: "RECEIPT_MISMATCH" });
    expect(await holds()).toHaveLength(0);
    const workspace = (await paymentsWorkspace(handle.db, session, v2.id))!;
    expect(workspace.plan?.status).toBe("blocked");
    await expect(start()).resolves.toMatchObject({ id: checkout.id }); // the open operation is resumed, never replaced
  });

  it("waits while PayPal reviews a pending authorization and records it once it is created", async () => {
    const checkout = await start();
    paypal.approve(checkout.paypalOrderId!);
    paypal.then("answer-pending");
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "awaiting_buyer" });
    expect(await holds()).toHaveLength(0);
    const pending = (await handle.db.select().from(paymentOperations))[0];
    expect(pending).toMatchObject({ status: "pending", failureCode: "AUTHORIZATION_PENDING" });
    Object.assign(paypal.hold(pending.paypalResourceId!)!, { status: "CREATED" });
    expect((await checkPayment(handle.db, paypal, session, v2.id, checkout.id, links)).status).toBe("succeeded");
    expect(await holds()).toHaveLength(1);
  });

  it("refuses new authorizations from a stale version while an already started checkout keeps its version", async () => {
    const checkout = await start();
    const v3 = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    await expect(start(v2)).rejects.toMatchObject({ code: "STALE_VERSION" });
    paypal.approve(checkout.paypalOrderId!);
    expect(await back(checkout.id, checkout.paypalOrderId)).toEqual({ orderId: v2.id, state: "authorized" });
    expect((await holds())[0]).toMatchObject({ changeOrderId: v2.id, amountCents: 54_375 });
    // The newer version counts the held $543.75 and asks only for the uncovered amount.
    const next = (await paymentsWorkspace(handle.db, session, v3.id))!;
    expect(next.lines.find((line) => line.itemId === CHAIR)).toMatchObject({ targetCents: 81_563, heldCents: 54_375, steps: expect.arrayContaining([expect.objectContaining({ kind: "authorize", amountCents: 27_188, available: true })]) });
  });

  it("lets neither a shared read-only link nor another session start or reconcile a checkout", async () => {
    await expect(start(v2, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const checkout = await start();
    await expect(checkPayment(handle.db, paypal, randomUUID(), v2.id, checkout.id, links)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancelPayment(handle.db, paypal, randomUUID(), v2.id, checkout.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const shared = (await paymentsWorkspace(handle.db, null, v2.id))!;
    expect(shared).toMatchObject({ canAct: false, operations: [expect.objectContaining({ approvalUrl: null })] });
    expect(shared.lines.every((line) => line.steps.every((step) => !step.available))).toBe(true);
    expect(await handle.db.select().from(paypalCalls)).toHaveLength(1);
  });
});
