import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { paymentOperations, paypalCaptures, paypalRefunds } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { checkPayment, startCapture, startRefund } from "./actions";
import { requestRefund } from "./refund";
import { recordSupplierCredit } from "./supplier";
import { confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, confirmSupplier, links, sixChairsHeld } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

describe.skipIf(!testDatabaseUrl)("returning captured chairs refunds the confirmed amount", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v4: FrozenChangeOrder;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    const { v3 } = await sixChairsHeld(handle.db, paypal, session);
    await confirmSupplier(handle.db, session, v3, "baseline");
    await startCapture(handle.db, paypal, session, v3.id, { itemId: CHAIR, side: "baseline", ...shown(v3) });
    // The client returns all six chairs; the supplier keeps a reviewed $25 handling cost.
    v4 = await confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "returned", oldItemCostCents: 2_500 });
  });
  afterAll(() => handle?.pool.end());

  const line = { itemId: CHAIR, side: "baseline" as const };
  const refund = () => startRefund(handle.db, paypal, session, v4.id, { ...line, ...shown(v4) });
  const credit = (creditCents: number) => recordSupplierCredit(handle.db, session, v4.id, { ...line, ...shown(v4), creditCents, reference: "DEMO-CREDIT-1", note: "Demo supplier credit entered by the designer." });
  const chair = async () => (await paymentsWorkspace(handle.db, session, v4.id))!.lines.find((entry) => entry.itemId === CHAIR)!;
  const refundCalls = () => paypal.calls.filter((call) => "paypalCaptureId" in call);

  it("waits for the supplier credit before any refund", async () => {
    const before = await chair();
    expect(before).toMatchObject({ change: "remove", targetCents: 2_500, capturedCents: 81_563, refundedCents: 0 });
    expect(before.steps.map((step) => [step.kind, step.amountCents, step.available])).toEqual([["supplier_credit", 79_063, true], ["refund", 79_063, false]]);
    await expect(refund()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/supplier's credit/) });
    expect(refundCalls()).toHaveLength(0);
  });

  it("goes back to pricing when the supplier credit differs from the confirmed retained cost", async () => {
    await expect(credit(80_000)).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED", message: expect.stringMatching(/\$800\.00.*\$790\.63/) });
    await expect(refund()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("refunds $790.63 across both captures, newest first, and keeps the $25 retained cost", async () => {
    await credit(79_063);
    expect((await chair()).steps).toEqual([expect.objectContaining({ kind: "refund", amountCents: 79_063, available: true })]);
    const done = await refund();
    expect(done.map((operation) => [operation.status, operation.amountCents])).toEqual([["succeeded", 27_188], ["succeeded", 51_875]]);
    const captures = await handle.db.select().from(paypalCaptures);
    const refunds = await handle.db.select().from(paypalRefunds);
    expect(refunds.map((entry) => entry.status)).toEqual(["completed", "completed"]);
    for (const entry of refunds) expect(captures.some((capture) => capture.id === entry.captureId)).toBe(true);
    expect(new Set(refunds.map((entry) => entry.paypalRefundId)).size).toBe(2);
    expect(await chair()).toMatchObject({ capturedCents: 81_563, refundedCents: 79_063, steps: [] });
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.filter((message) => message.text.includes("refund completed"))).toHaveLength(2);
    // Repeating the step finds the same refunds and sends nothing new.
    expect((await refund()).map((operation) => operation.id)).toEqual(done.map((operation) => operation.id));
    expect(refundCalls()).toHaveLength(2);
  });

  it("does not count a pending refund as returned and never sends it twice", async () => {
    await credit(79_063);
    paypal.then("answer-pending");
    const [first] = await refund();
    const pending = (await handle.db.select().from(paypalRefunds)).find((entry) => entry.status === "pending")!;
    expect(await chair()).toMatchObject({ refundedCents: 51_875, refunds: expect.arrayContaining([expect.objectContaining({ status: "pending", amountCents: 27_188 })]) });
    expect((await paymentsWorkspace(handle.db, session, v4.id))!.plan?.status).toBe("blocked");
    await expect(refund()).rejects.toMatchObject({ code: "PLAN_BLOCKED" });

    paypal.settleRefund(pending.paypalRefundId, "COMPLETED");
    await checkPayment(handle.db, paypal, session, v4.id, first.id, links);
    expect((await chair()).refundedCents).toBe(79_063);
    expect(refundCalls()).toHaveLength(2);
  });

  it("never lets refunds of a capture add up to more than it", async () => {
    await credit(79_063);
    await refund();
    const [capture] = (await handle.db.select().from(paypalCaptures)).filter((entry) => entry.amountCents === 54_375);
    await expect(requestRefund(handle.db, { businessKey: "test:extra-refund", projectId: capture.projectId, captureId: capture.id, amountCents: 2_501 })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/would exceed capture/) });
    expect((await handle.db.select().from(paymentOperations)).filter((operation) => operation.kind === "refund")).toHaveLength(2);
  });
});
