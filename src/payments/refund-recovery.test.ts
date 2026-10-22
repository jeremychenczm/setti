import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentOperations, paypalCaptures, paypalRefunds } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { checkPayment, startCapture, startRefund } from "./actions";
import type { RefundCommand } from "./paypal";
import { paypalCalls } from "./schema";
import { recordSupplierCredit } from "./supplier";
import { confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, confirmSupplier, links, sixChairsHeld } from "./testing/flows";

describe.skipIf(!testDatabaseUrl)("a refund whose PayPal answer was lost", () => {
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
    v4 = await confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "returned", oldItemCostCents: 2_500 });
    await recordSupplierCredit(handle.db, session, v4.id, { itemId: CHAIR, side: "baseline", ...shown(v4), creditCents: 79_063, reference: "DEMO-CREDIT-1", note: "Demo supplier credit entered by the designer." });
  });
  afterAll(() => handle?.pool.end());

  const refund = () => startRefund(handle.db, paypal, session, v4.id, { itemId: CHAIR, side: "baseline", ...shown(v4) });
  const check = (operationId: string) => checkPayment(handle.db, paypal, session, v4.id, operationId, links);
  const refundCalls = () => paypal.calls.filter((call): call is RefundCommand => "paypalCaptureId" in call && "customId" in call);
  const lookups = async (operationId: string) => (await handle.db.select().from(paypalCalls)).filter((call) => call.operationId === operationId && call.step === "get_order");

  it("adopts the refund PayPal made instead of sending a second one", async () => {
    paypal.then("lose-response");
    const [lost] = await refund();
    expect(lost.status).toBe("unknown");
    const sent = refundCalls().length;
    const done = await check(lost.id);
    expect(done).toMatchObject({ status: "succeeded", failureCode: null });
    expect(refundCalls()).toHaveLength(sent);
    const refunds = (await handle.db.select().from(paypalRefunds)).filter((entry) => entry.operationId === lost.id);
    expect(refunds).toEqual([expect.objectContaining({ status: "completed", amountCents: lost.amountCents, paypalRefundId: done.paypalResourceId })]);
    expect((await lookups(lost.id)).map((call) => call.details)).toEqual([expect.objectContaining({ refundLookup: true, matchingRefunds: 1 })]);
  });

  it("sends the refund again with the same request id when PayPal has none for this step", async () => {
    paypal.then("time-out");
    const [timedOut] = await refund();
    expect(timedOut.status).toBe("unknown");
    const done = await check(timedOut.id);
    expect(done.status).toBe("succeeded");
    const forStep = refundCalls().filter((call) => call.customId === timedOut.id);
    expect(forStep.map((call) => call.requestId)).toEqual([timedOut.requestId, timedOut.requestId]);
    expect((await lookups(timedOut.id)).map((call) => call.details)).toEqual([expect.objectContaining({ matchingRefunds: 0 })]);
  });

  it("sends nothing when the PayPal order cannot be read", async () => {
    paypal.then("lose-response");
    const [lost] = await refund();
    const sent = refundCalls().length;
    paypal.readsUnavailable = true;
    expect(await check(lost.id)).toMatchObject({ status: "unknown", failureCode: "REFUND_LOOKUP_FAILED", failureMessage: expect.stringMatching(/no refund was sent again/) });
    expect(refundCalls()).toHaveLength(sent);
    expect((await handle.db.select().from(paypalRefunds)).filter((entry) => entry.operationId === lost.id)).toHaveLength(0);
  });

  it("stops for a person when PayPal lists more than one refund for the step", async () => {
    paypal.then("lose-response");
    const [lost] = await refund();
    const [capture] = await handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.id, lost.captureId!));
    paypal.refundElsewhere(capture.paypalCaptureId, 100, lost.id);
    const sent = refundCalls().length;
    expect(await check(lost.id)).toMatchObject({ status: "unknown", failureCode: "DUPLICATE_REFUNDS" });
    expect(refundCalls()).toHaveLength(sent);
    expect((await handle.db.select().from(paymentOperations)).find((operation) => operation.id === lost.id)?.status).toBe("unknown");
  });
});
