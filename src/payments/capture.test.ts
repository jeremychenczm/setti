import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentOperations, paypalAuthorizations, paypalCalls, paypalCaptures, projects } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { executeCapture, refreshCapture, requestCapture } from "./capture";
import { holdSummary } from "./holds";
import { FakePayPal } from "./testing/fake-paypal";

describe.skipIf(!testDatabaseUrl)("capture executor", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let projectId: string;
  let authorizationId: string;
  let paypal: FakePayPal;
  let key = 0;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  afterAll(() => handle?.pool.end());

  beforeEach(async () => {
    await truncate(handle.db, "paypal_calls", "payment_operations", "paypal_refunds", "paypal_captures", "paypal_authorizations", "projects");
    const [project] = await handle.db.insert(projects).values({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park" }).returning();
    projectId = project.id;
    const [desk] = await handle.db
      .insert(paypalAuthorizations)
      .values({ projectId, paypalOrderId: "ORDER-DESK", paypalAuthorizationId: "AUTH-DESK", amountCents: 110_000 })
      .returning();
    authorizationId = desk.id;
    paypal = new FakePayPal();
  });

  const capturesOnDesk = () => handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.authorizationId, authorizationId));
  const statusOfDesk = async () => (await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId)))[0].status;
  const capture = (amountCents: number, finalCapture = false) => requestCapture(handle.db, { businessKey: `test:capture:${++key}`, projectId, authorizationId, amountCents, finalCapture });

  it("records the capture and marks the operation succeeded", async () => {
    const operation = await capture(110_000, true);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("succeeded");
    const captures = await capturesOnDesk();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ amountCents: 110_000, currency: "USD", finalCapture: true, status: "completed", paypalCaptureId: done.paypalResourceId, operationId: operation.id });
    expect(paypal.calls[0]).toMatchObject({ paypalAuthorizationId: "AUTH-DESK", requestId: operation.requestId });
    expect(await statusOfDesk()).toBe("captured");
    const [call] = await handle.db.select().from(paypalCalls).where(eq(paypalCalls.operationId, operation.id));
    expect(call).toMatchObject({ step: "capture", outcome: "ok", requestId: operation.requestId, resourceId: done.paypalResourceId, resourceStatus: "COMPLETED", amountCents: 110_000, currency: "USD" });
  });

  it("returns the same operation when the same business event is requested twice, even at once", async () => {
    const input = { businessKey: "test:capture:twice", projectId, authorizationId, amountCents: 50_000 };
    const [first, second] = await Promise.all([requestCapture(handle.db, input), requestCapture(handle.db, input)]);
    expect(second.id).toBe(first.id);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
    await expect(requestCapture(handle.db, { ...input, amountCents: 60_000 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("marks the operation failed with PayPal's reason when PayPal refuses", async () => {
    paypal.then("reject-over-limit");
    const operation = await capture(115_000);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "failed", failureCode: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
    expect(await capturesOnDesk()).toHaveLength(0);
  });

  it("refuses to write down a capture beyond the hold and its allowance before PayPal is asked", async () => {
    // The hold allows at most $1,100 plus $75.
    await expect(capture(117_501)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/would exceed authorization/) });
    expect(paypal.calls).toHaveLength(0);
  });

  it("marks a timed-out capture unknown, then records it once when the retry finds PayPal already took it", async () => {
    paypal.then("lose-response");
    const operation = await capture(50_000);

    const first = await executeCapture(handle.db, paypal, operation.id);
    expect(first.status).toBe("unknown");
    expect(await capturesOnDesk()).toHaveLength(0);

    const retried = await executeCapture(handle.db, paypal, operation.id);
    expect(retried).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(paypal.calls.map((c) => c.requestId)).toEqual([operation.requestId, operation.requestId]);
    expect(await capturesOnDesk()).toHaveLength(1);
  });

  it("refuses a second capture while the first one's outcome is unknown", async () => {
    paypal.then("lose-response");
    const operation = await capture(50_000);
    await executeCapture(handle.db, paypal, operation.id);
    await expect(capture(10_000)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/unresolved operation/) });
  });

  it("does not call PayPal again for an operation that already succeeded", async () => {
    const operation = await capture(50_000);
    await executeCapture(handle.db, paypal, operation.id);
    const again = await executeCapture(handle.db, paypal, operation.id);

    expect(again.status).toBe("succeeded");
    expect(paypal.calls).toHaveLength(1);
    expect(await capturesOnDesk()).toHaveLength(1);
  });

  it("records a pending capture as pending, not completed, until PayPal reports it settled", async () => {
    paypal.then("answer-pending");
    const operation = await capture(50_000);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("succeeded");
    const [pending] = await capturesOnDesk();
    expect(pending.status).toBe("pending");
    expect(await statusOfDesk()).toBe("created");

    paypal.settleCapture(pending.paypalCaptureId, "COMPLETED");
    expect((await refreshCapture(handle.db, paypal, pending.id)).status).toBe("completed");
    expect(await statusOfDesk()).toBe("partially_captured");
  });

  it("fails a declined capture and keeps the declined record without counting it", async () => {
    paypal.then("answer-declined");
    const operation = await capture(50_000);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "failed", failureCode: "CAPTURE_DECLINED" });
    expect((await capturesOnDesk())[0].status).toBe("declined");
    expect(await holdSummary(handle.db, authorizationId)).toMatchObject({ capturedCents: 0, heldCents: 110_000 });
  });

  it("reads back a capture whose receipt left out the status and amount instead of assuming it completed", async () => {
    paypal.then("answer-minimal");
    const operation = await capture(50_000);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("succeeded");
    expect(paypal.reads).toEqual([done.paypalResourceId]);
    expect((await capturesOnDesk())[0]).toMatchObject({ status: "completed", amountCents: 50_000 });
  });

  it("stops for reconciliation when PayPal reports a different amount", async () => {
    paypal.then("answer-other-amount");
    const operation = await capture(50_000);
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "unknown", failureCode: "RECEIPT_MISMATCH" });
    expect(done.paypalResourceId).toBeTruthy();
    expect(await capturesOnDesk()).toHaveLength(0);
    // Checking again reads the same capture back; it is still different, so nothing is recorded.
    expect(await executeCapture(handle.db, paypal, operation.id)).toMatchObject({ status: "unknown", failureCode: "RECEIPT_MISMATCH" });
    expect(paypal.calls).toHaveLength(1);
  });

  it("records an expired hold when PayPal refuses the capture for that reason", async () => {
    paypal.then("reject-expired");
    const operation = await capture(50_000);
    expect(await executeCapture(handle.db, paypal, operation.id)).toMatchObject({ status: "failed", failureCode: "AUTHORIZATION_EXPIRED" });
    expect(await statusOfDesk()).toBe("expired");
    await expect(capture(10_000)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/closed/) });
  });

  it("flags the operation for a person when PayPal took money our records refuse", async () => {
    const operation = await capture(50_000);
    // The hold is voided by another path after the capture was written down.
    await handle.db.update(paypalAuthorizations).set({ status: "voided" }).where(eq(paypalAuthorizations.id, authorizationId));
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("unknown");
    expect(done.failureCode).toBe("LOCAL_RECORD_REJECTED");
    expect(done.paypalResourceId).toBeTruthy();
    expect(await capturesOnDesk()).toHaveLength(0);
  });
});
