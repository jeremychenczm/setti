import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentOperations, paypalAuthorizations, paypalCaptures, projects } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { executeCapture, requestCapture } from "./capture";
import { holdSummary } from "./holds";
import { FakePayPal } from "./testing/fake-paypal";
import { executeVoid, requestVoid } from "./void";

describe.skipIf(!testDatabaseUrl)("void executor", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let projectId: string;
  let paypal: FakePayPal;
  let sequence = 0;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  afterAll(() => handle?.pool.end());

  beforeEach(async () => {
    await truncate(handle.db, "paypal_calls", "payment_operations", "paypal_refunds", "paypal_captures", "paypal_authorizations", "projects");
    const [project] = await handle.db.insert(projects).values({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park" }).returning();
    projectId = project.id;
    paypal = new FakePayPal();
  });

  async function hold(amountCents: number) {
    sequence += 1;
    const [auth] = await handle.db
      .insert(paypalAuthorizations)
      .values({ projectId, paypalOrderId: `ORDER-${sequence}`, paypalAuthorizationId: `AUTH-${sequence}`, amountCents })
      .returning();
    return auth;
  }

  const voidOf = (authorizationId: string, key = `test:void:${authorizationId}`) => requestVoid(handle.db, { businessKey: key, projectId, authorizationId });
  const captureOf = (authorizationId: string, amountCents: number, finalCapture = false) =>
    requestCapture(handle.db, { businessKey: `test:capture:${authorizationId}:${amountCents}`, projectId, authorizationId, amountCents, finalCapture });
  const statusOf = async (authorizationId: string) =>
    (await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId)))[0].status;

  it("voids the chair hold, after which the database refuses to capture from it", async () => {
    const chair = await hold(80_000);
    const operation = await voidOf(chair.id);
    const done = await executeVoid(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "succeeded", amountCents: 80_000, paypalResourceId: chair.paypalAuthorizationId });
    expect(await statusOf(chair.id)).toBe("voided");

    const late = handle.db.insert(paypalCaptures).values({ projectId, authorizationId: chair.id, paypalCaptureId: "CAPTURE-LATE", amountCents: 80_000 });
    const error = await late.then(() => undefined, (e: { cause?: Error }) => e.cause?.message);
    expect(error).toMatch(/voided/);
    await expect(captureOf(chair.id, 80_000)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/closed/) });
  });

  it("returns the same void when the release is requested again, even after it succeeded", async () => {
    const chair = await hold(80_000);
    const first = await voidOf(chair.id, "test:void:again");
    await executeVoid(handle.db, paypal, first.id);
    expect((await voidOf(chair.id, "test:void:again")).id).toBe(first.id);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
  });

  it("leaves the hold untouched when PayPal refuses the void", async () => {
    paypal.then("reject-already-captured");
    const chair = await hold(80_000);
    const operation = await voidOf(chair.id);
    const done = await executeVoid(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "failed", failureCode: "AUTHORIZATION_ALREADY_CAPTURED" });
    expect(await statusOf(chair.id)).toBe("created");
  });

  it("finishes a void whose response was lost by retrying with the same request id", async () => {
    paypal.then("lose-response");
    const chair = await hold(80_000);
    const operation = await voidOf(chair.id);

    expect((await executeVoid(handle.db, paypal, operation.id)).status).toBe("unknown");
    expect(await statusOf(chair.id)).toBe("created");

    const retried = await executeVoid(handle.db, paypal, operation.id);
    expect(retried).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(paypal.calls.map((c) => c.requestId)).toEqual([operation.requestId, operation.requestId]);
    expect(await statusOf(chair.id)).toBe("voided");
  });

  it("reads the hold back when PayPal accepts the void without saying what it is now", async () => {
    paypal.then("answer-minimal");
    const chair = await hold(80_000);
    const done = await executeVoid(handle.db, paypal, (await voidOf(chair.id)).id);
    expect(done.status).toBe("succeeded");
    expect(paypal.reads).toEqual([chair.paypalAuthorizationId]);
  });

  it("does not call PayPal again for a void that already succeeded", async () => {
    const chair = await hold(80_000);
    const operation = await voidOf(chair.id);
    await executeVoid(handle.db, paypal, operation.id);
    await executeVoid(handle.db, paypal, operation.id);
    expect(paypal.calls).toHaveLength(1);
  });

  it("keeps capture and void of one hold on one path: neither starts while the other is unresolved", async () => {
    paypal.then("lose-response");
    const chair = await hold(80_000);
    const capture = await captureOf(chair.id, 80_000, true);
    await executeCapture(handle.db, paypal, capture.id);
    await expect(voidOf(chair.id)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/unresolved operation/) });

    const table = await hold(50_000);
    paypal.then("lose-response");
    await executeVoid(handle.db, paypal, (await voidOf(table.id)).id);
    await expect(captureOf(table.id, 50_000)).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/unresolved operation/) });
  });

  it("works out that voiding a $100 hold after a $40 capture releases $60", async () => {
    const lamp = await hold(10_000);
    const capture = await captureOf(lamp.id, 4_000);
    await executeCapture(handle.db, paypal, capture.id);

    const operation = await voidOf(lamp.id);
    expect(operation.amountCents).toBe(6_000);
    await executeVoid(handle.db, paypal, operation.id);

    expect(await holdSummary(handle.db, lamp.id)).toEqual({ authorizedCents: 10_000, capturedCents: 4_000, heldCents: 0, releasedCents: 6_000 });
    const [kept] = await handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.authorizationId, lamp.id));
    expect(kept).toMatchObject({ amountCents: 4_000, status: "completed" });
  });

  it("refuses to write down a void when nothing is left on hold", async () => {
    const rug = await hold(30_000);
    const capture = await captureOf(rug.id, 30_000, true);
    await executeCapture(handle.db, paypal, capture.id);
    await expect(voidOf(rug.id)).rejects.toThrow(/Nothing is left on hold/);
  });
});
