import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { createChatStore } from "../chat/store";
import { paymentOperations, paypalAuthorizations, paypalCaptures, supplierEvents } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { checkPayment, startCapture } from "./actions";
import { confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, confirmSupplier, links, sixChairsHeld } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

describe.skipIf(!testDatabaseUrl)("supplier confirmation and capture", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v3: FrozenChangeOrder;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    ({ v3 } = await sixChairsHeld(handle.db, paypal, session));
  });
  afterAll(() => handle?.pool.end());

  const capture = () => startCapture(handle.db, paypal, session, v3.id, { itemId: CHAIR, side: "baseline", ...shown(v3) });
  const chair = async () => (await paymentsWorkspace(handle.db, session, v3.id, undefined, DEMO_ACCOUNTS[0]))!.lines.find((line) => line.itemId === CHAIR)!;
  const captureCalls = () => paypal.calls.filter((call) => "finalCapture" in call);

  it("captures nothing until the supplier confirmation is recorded", async () => {
    expect((await chair()).steps.map((step) => [step.kind, step.available])).toEqual([["supplier_confirmation", true], ["capture", false]]);
    await expect(capture()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/supplier/) });
    expect(captureCalls()).toHaveLength(0);
  });

  it("refuses supplier terms that differ from the confirmed version and sends the change back to pricing", async () => {
    await expect(confirmSupplier(handle.db, session, v3, "baseline", { unitPriceCents: 13_000 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED", details: [expect.stringMatching(/unit price \$130\.00 instead of \$125\.00/)] });
    await expect(confirmSupplier(handle.db, session, v3, "baseline", { quantity: 5 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED" });
    await expect(confirmSupplier(handle.db, session, v3, "baseline", { inStock: false })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(confirmSupplier(handle.db, randomUUID(), v3, "baseline")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await handle.db.select().from(supplierEvents)).toHaveLength(0);
    await expect(capture()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("captures each hold separately for the confirmed $815.63 after a matching supplier confirmation", async () => {
    const event = await confirmSupplier(handle.db, session, v3, "baseline");
    expect(event).toMatchObject({ kind: "order_confirmed", quantity: 6, totalCents: 81_563, isDemo: true });
    expect((await chair()).steps).toEqual([expect.objectContaining({ kind: "capture", amountCents: 81_563, available: true })]);

    const done = await capture();
    expect(done.map((operation) => [operation.status, operation.amountCents, operation.finalCapture])).toEqual([["succeeded", 54_375, true], ["succeeded", 27_188, true]]);
    expect(done.every((operation) => operation.supplierEventId === event.id && operation.changeOrderId === v3.id)).toBe(true);
    const captures = await handle.db.select().from(paypalCaptures);
    expect(captures.map((entry) => [entry.amountCents, entry.status]).sort()).toEqual([[27_188, "completed"], [54_375, "completed"]]);
    expect(new Set(captures.map((entry) => entry.paypalCaptureId)).size).toBe(2);
    expect((await handle.db.select().from(paypalAuthorizations)).map((hold) => hold.status)).toEqual(["captured", "captured"]);

    const line = await chair();
    expect(line).toMatchObject({ targetCents: 81_563, capturedCents: 81_563, heldCents: 0, steps: [] });
    expect((await paymentsWorkspace(handle.db, session, v3.id))!.lines).toHaveLength(1); // no other line is shown as funded or paid
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.filter((message) => message.text.includes("capture completed"))).toHaveLength(2);

    // Repeating the step finds the same captures and never sends them again.
    const again = await capture();
    expect(again.map((operation) => operation.id)).toEqual(done.map((operation) => operation.id));
    expect(captureCalls()).toHaveLength(2);
  });

  it("shows a partial capture while the second is pending, then completes it without capturing the first again", async () => {
    await confirmSupplier(handle.db, session, v3, "baseline");
    paypal.then("succeed", "answer-pending");
    const [first, second] = await capture();
    expect([first.status, second.status]).toEqual(["succeeded", "succeeded"]);
    const pending = (await handle.db.select().from(paypalCaptures)).find((entry) => entry.status === "pending")!;
    const partial = await chair();
    expect(partial).toMatchObject({ capturedCents: 54_375, heldCents: 27_188, releasedCents: 0, captures: expect.arrayContaining([expect.objectContaining({ status: "pending", amountCents: 27_188 })]) });
    expect(partial.holds.find((hold) => hold.status === "created")).toMatchObject({ heldCents: 27_188, releasedCents: 0 });
    expect((await paymentsWorkspace(handle.db, session, v3.id))!.plan?.status).toBe("blocked");
    await expect(capture()).rejects.toMatchObject({ code: "PLAN_BLOCKED" });

    paypal.settleCapture(pending.paypalCaptureId, "COMPLETED");
    await checkPayment(handle.db, paypal, session, v3.id, second.id, links);
    expect(await chair()).toMatchObject({ capturedCents: 81_563, heldCents: 0 });
    expect(captureCalls()).toHaveLength(2);
  });

  it("lets the owner reconcile a pending capture from a superseded version without starting new money steps there", async () => {
    await confirmSupplier(handle.db, session, v3, "baseline");
    paypal.then("succeed", "answer-pending");
    const [, second] = await capture();
    const pending = (await handle.db.select().from(paypalCaptures)).find((entry) => entry.status === "pending")!;
    await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 7, after: { taxCents: 7_656 } });

    const historical = (await paymentsWorkspace(handle.db, session, v3.id))!;
    expect(historical).toMatchObject({ current: false, canAct: false, canReconcile: true });
    expect(historical.lines.every((line) => line.steps.every((step) => !step.available))).toBe(true);
    expect(await paymentsWorkspace(handle.db, null, v3.id)).toMatchObject({ canAct: false, canReconcile: false });
    await expect(startCapture(handle.db, paypal, session, v3.id, { itemId: CHAIR, side: "baseline", ...shown(v3) })).rejects.toMatchObject({ code: "STALE_VERSION" });

    paypal.settleCapture(pending.paypalCaptureId, "COMPLETED");
    await checkPayment(handle.db, paypal, session, v3.id, second.id, links);
    expect(await chair()).toMatchObject({ capturedCents: 81_563, heldCents: 0, releasedCents: 0 });
    expect(captureCalls()).toHaveLength(2);
  });

  it("reconciles a capture whose response was lost with the same request id instead of starting another", async () => {
    await confirmSupplier(handle.db, session, v3, "baseline");
    paypal.then("succeed", "lose-response");
    const [, lost] = await capture();
    expect(lost.status).toBe("unknown");
    expect((await chair()).capturedCents).toBe(54_375);

    const [retried] = await capture();
    expect(retried).toMatchObject({ id: lost.id, status: "succeeded" });
    const sent = captureCalls();
    expect(sent).toHaveLength(3);
    expect(sent[1].requestId).toBe(sent[2].requestId);
    expect(await handle.db.select().from(paypalCaptures)).toHaveLength(2);
    expect((await handle.db.select().from(paymentOperations)).filter((operation) => operation.kind === "capture")).toHaveLength(2);
  });
});
