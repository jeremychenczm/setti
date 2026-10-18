import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paypalAuthorizations, paypalCaptures, projects } from "../db/schema";
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
    await truncate(handle.db, "payment_operations", "paypal_refunds", "paypal_captures", "paypal_authorizations", "projects");
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

  const statusOf = async (authorizationId: string) =>
    (await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId)))[0].status;

  it("voids the chair hold, after which the database refuses to capture from it", async () => {
    const chair = await hold(80_000);
    const operation = await requestVoid(handle.db, { projectId, authorizationId: chair.id });
    const done = await executeVoid(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "succeeded", amountCents: 80_000, paypalResourceId: chair.paypalAuthorizationId });
    expect(await statusOf(chair.id)).toBe("voided");

    const late = handle.db.insert(paypalCaptures).values({ projectId, authorizationId: chair.id, paypalCaptureId: "CAPTURE-LATE", amountCents: 80_000 });
    const error = await late.then(() => undefined, (e: { cause?: Error }) => e.cause?.message);
    expect(error).toMatch(/voided/);
  });

  it("leaves the hold untouched when PayPal refuses the void", async () => {
    paypal.then("reject-already-captured");
    const chair = await hold(80_000);
    const operation = await requestVoid(handle.db, { projectId, authorizationId: chair.id });
    const done = await executeVoid(handle.db, paypal, operation.id);

    expect(done).toMatchObject({ status: "failed", failureCode: "AUTHORIZATION_ALREADY_CAPTURED" });
    expect(await statusOf(chair.id)).toBe("created");
  });

  it("finishes a void whose response was lost by retrying with the same request id", async () => {
    paypal.then("lose-response");
    const chair = await hold(80_000);
    const operation = await requestVoid(handle.db, { projectId, authorizationId: chair.id });

    expect((await executeVoid(handle.db, paypal, operation.id)).status).toBe("unknown");
    expect(await statusOf(chair.id)).toBe("created");

    const retried = await executeVoid(handle.db, paypal, operation.id);
    expect(retried).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(paypal.calls.map((c) => c.requestId)).toEqual([operation.requestId, operation.requestId]);
    expect(await statusOf(chair.id)).toBe("voided");
  });

  it("does not call PayPal again for a void that already succeeded", async () => {
    const chair = await hold(80_000);
    const operation = await requestVoid(handle.db, { projectId, authorizationId: chair.id });
    await executeVoid(handle.db, paypal, operation.id);
    await executeVoid(handle.db, paypal, operation.id);
    expect(paypal.calls).toHaveLength(1);
  });

  it("works out that voiding a $100 hold after a $40 capture releases $60", async () => {
    const lamp = await hold(10_000);
    const capture = await requestCapture(handle.db, { projectId, authorizationId: lamp.id, amountCents: 4_000 });
    await executeCapture(handle.db, paypal, capture.id);

    const operation = await requestVoid(handle.db, { projectId, authorizationId: lamp.id });
    expect(operation.amountCents).toBe(6_000);
    await executeVoid(handle.db, paypal, operation.id);

    expect(await holdSummary(handle.db, lamp.id)).toEqual({ authorizedCents: 10_000, capturedCents: 4_000, heldCents: 0, releasedCents: 6_000 });
  });

  it("refuses to write down a void when nothing is left on hold", async () => {
    const rug = await hold(30_000);
    const capture = await requestCapture(handle.db, { projectId, authorizationId: rug.id, amountCents: 30_000, finalCapture: true });
    await executeCapture(handle.db, paypal, capture.id);
    await expect(requestVoid(handle.db, { projectId, authorizationId: rug.id })).rejects.toThrow(/Nothing is left on hold/);
  });
});
