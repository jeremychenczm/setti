import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paypalAuthorizations, paypalCaptures, projects } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { executeCapture, requestCapture } from "./capture";
import { FakePayPal } from "./testing/fake-paypal";

describe.skipIf(!testDatabaseUrl)("capture executor", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let projectId: string;
  let authorizationId: string;
  let paypal: FakePayPal;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  afterAll(() => handle?.pool.end());

  beforeEach(async () => {
    await truncate(handle.db, "payment_operations", "paypal_refunds", "paypal_captures", "paypal_authorizations", "projects");
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

  it("records the capture and marks the operation succeeded", async () => {
    const operation = await requestCapture(handle.db, { projectId, authorizationId, amountCents: 110_000, finalCapture: true });
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("succeeded");
    const captures = await capturesOnDesk();
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ amountCents: 110_000, finalCapture: true, status: "completed", paypalCaptureId: done.paypalResourceId });
    expect(paypal.calls[0]).toMatchObject({ paypalAuthorizationId: "AUTH-DESK", requestId: operation.requestId });
  });

  it("marks the operation failed with PayPal's reason when PayPal refuses", async () => {
    paypal.then("reject-over-limit");
    const operation = await requestCapture(handle.db, { projectId, authorizationId, amountCents: 130_000 });
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "failed", failureCode: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
    expect(await capturesOnDesk()).toHaveLength(0);
  });

  it("marks a timed-out capture unknown, then records it once when the retry finds PayPal already took it", async () => {
    paypal.then("lose-response");
    const operation = await requestCapture(handle.db, { projectId, authorizationId, amountCents: 50_000 });

    const first = await executeCapture(handle.db, paypal, operation.id);
    expect(first.status).toBe("unknown");
    expect(await capturesOnDesk()).toHaveLength(0);

    const retried = await executeCapture(handle.db, paypal, operation.id);
    expect(retried).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(paypal.calls.map((c) => c.requestId)).toEqual([operation.requestId, operation.requestId]);
    expect(await capturesOnDesk()).toHaveLength(1);
  });

  it("does not call PayPal again for an operation that already succeeded", async () => {
    const operation = await requestCapture(handle.db, { projectId, authorizationId, amountCents: 50_000 });
    await executeCapture(handle.db, paypal, operation.id);
    const again = await executeCapture(handle.db, paypal, operation.id);

    expect(again.status).toBe("succeeded");
    expect(paypal.calls).toHaveLength(1);
    expect(await capturesOnDesk()).toHaveLength(1);
  });

  it("flags the operation for a person when PayPal took money our records refuse", async () => {
    // The hold allows at most $1,175 (plus $75); pretend PayPal still captured $1,500.
    const operation = await requestCapture(handle.db, { projectId, authorizationId, amountCents: 150_000 });
    const done = await executeCapture(handle.db, paypal, operation.id);

    expect(done.status).toBe("unknown");
    expect(done.failureCode).toBe("LOCAL_RECORD_REJECTED");
    expect(done.paypalResourceId).toBeTruthy();
    expect(await capturesOnDesk()).toHaveLength(0);
  });
});
