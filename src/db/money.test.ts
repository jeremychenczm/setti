import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paypalAuthorizations, paypalCaptures, paypalRefunds, projects } from "./schema";
import { openTestDb, testDatabaseUrl, truncate } from "./testing";

/** Drizzle wraps driver errors; the database's own message is on `cause`. */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the database to reject this").toBeDefined();
  const cause = (error as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? (error as Error).message).toMatch(pattern);
}

describe.skipIf(!testDatabaseUrl)("PayPal money records", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let projectId: string;
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  afterAll(() => handle?.pool.end());

  beforeEach(async () => {
    await truncate(handle.db, "paypal_refunds", "paypal_captures", "paypal_authorizations", "projects");
    const [project] = await handle.db.insert(projects).values({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park" }).returning();
    projectId = project.id;
  });

  async function hold(amountCents: number, status: "created" | "voided" = "created") {
    const [auth] = await handle.db
      .insert(paypalAuthorizations)
      .values({ projectId, paypalOrderId: nextId("ORDER"), paypalAuthorizationId: nextId("AUTH"), amountCents, status })
      .returning();
    return auth;
  }

  function capture(amountCents: number, opts: { authorizationId?: string; finalCapture?: boolean } = {}) {
    return handle.db
      .insert(paypalCaptures)
      .values({ projectId, paypalCaptureId: nextId("CAPTURE"), amountCents, authorizationId: opts.authorizationId, finalCapture: opts.finalCapture ?? false })
      .returning()
      .then((rows) => rows[0]);
  }

  function refund(captureId: string, amountCents: number) {
    return handle.db.insert(paypalRefunds).values({ captureId, paypalRefundId: nextId("REFUND"), amountCents }).returning();
  }

  it("takes a $1,100 hold in two partial captures and refuses a capture after the final one", async () => {
    const desk = await hold(110_000);
    await capture(50_000, { authorizationId: desk.id });
    await capture(60_000, { authorizationId: desk.id, finalCapture: true });
    await expectRejected(capture(1_000, { authorizationId: desk.id }), /already had its final capture/);
  });

  it("allows capturing up to 15% over a $100 hold, and not one cent more", async () => {
    await capture(11_500, { authorizationId: (await hold(10_000)).id });
    await expectRejected(capture(11_501, { authorizationId: (await hold(10_000)).id }), /would exceed authorization/);
  });

  it("caps the over-capture at $75 on a $1,000 hold", async () => {
    await capture(107_500, { authorizationId: (await hold(100_000)).id });
    await expectRejected(capture(107_501, { authorizationId: (await hold(100_000)).id }), /would exceed authorization/);
  });

  it("refuses to capture from a voided hold", async () => {
    const voided = await hold(80_000, "voided");
    await expectRejected(capture(80_000, { authorizationId: voided.id }), /voided/);
  });

  it("refunds $240 of a $300 capture and refuses another $61", async () => {
    const rug = await capture(30_000);
    await refund(rug.id, 24_000);
    await expectRejected(refund(rug.id, 6_100), /refunds would exceed capture/);
    await refund(rug.id, 6_000);
  });

  it("refuses to refund a capture that is still pending", async () => {
    const [pending] = await handle.db
      .insert(paypalCaptures)
      .values({ projectId, paypalCaptureId: nextId("CAPTURE"), amountCents: 30_000, status: "pending" })
      .returning();
    await expectRejected(refund(pending.id, 1_000), /only completed captures/);
  });

  it("records each PayPal id once, so a retried write cannot double-count", async () => {
    const first = await capture(15_000);
    await expectRejected(
      handle.db.insert(paypalCaptures).values({ projectId, paypalCaptureId: first.paypalCaptureId, amountCents: 15_000 }),
      /paypal_capture_id/,
    );
  });

  it("never changes or deletes a recorded amount", async () => {
    const charged = await capture(15_000);
    await expectRejected(handle.db.update(paypalCaptures).set({ amountCents: 1 }).where(eq(paypalCaptures.id, charged.id)), /amount_cents cannot change/);
    await expectRejected(handle.db.delete(paypalCaptures).where(eq(paypalCaptures.id, charged.id)), /cannot be deleted/);
    // Status moves only forward: a completed capture stays completed...
    await expectRejected(handle.db.update(paypalCaptures).set({ status: "declined" }).where(eq(paypalCaptures.id, charged.id)), /cannot go from completed to declined/);
    // ...while PayPal may still report a pending capture as declined.
    const [pending] = await handle.db.insert(paypalCaptures).values({ projectId, paypalCaptureId: nextId("CAPTURE"), amountCents: 15_000, status: "pending" }).returning();
    await handle.db.update(paypalCaptures).set({ status: "declined" }).where(eq(paypalCaptures.id, pending.id));
  });

  it("moves hold and refund statuses only forward", async () => {
    const voided = await hold(10_000, "voided");
    await expectRejected(handle.db.update(paypalAuthorizations).set({ status: "created" }).where(eq(paypalAuthorizations.id, voided.id)), /cannot go from voided to created/);
    await expectRejected(handle.db.update(paypalAuthorizations).set({ itemId: null, changeOrderId: null, currency: "EUR" }).where(eq(paypalAuthorizations.id, voided.id)), /cannot change|paypal_authorizations_usd/);
    const charged = await capture(10_000);
    const [done] = await handle.db.insert(paypalRefunds).values({ captureId: charged.id, paypalRefundId: nextId("REFUND"), amountCents: 1_000, status: "completed" }).returning();
    await expectRejected(handle.db.update(paypalRefunds).set({ status: "pending" }).where(eq(paypalRefunds.id, done.id)), /cannot go from completed to pending/);
  });

  it("checks two simultaneous captures one at a time, so together they cannot exceed the hold", async () => {
    const shared = await hold(100_000); // allows up to $1,075 in total
    const first = await handle.pool.connect();
    const second = await handle.pool.connect();
    const insert = `INSERT INTO paypal_captures (project_id, authorization_id, paypal_capture_id, amount_cents) VALUES ($1, $2, $3, $4)`;

    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      // Each capture fits on its own; together ($1,100) they do not.
      await first.query(insert, [projectId, shared.id, nextId("CAPTURE"), 60_000]);
      const secondInsert = second.query(insert, [projectId, shared.id, nextId("CAPTURE"), 50_000]).then(
        () => "inserted" as const,
        (e: Error) => e.message,
      );

      // The second capture waits for the first transaction instead of reading a stale total.
      const stillWaiting = await Promise.race([secondInsert, new Promise((r) => setTimeout(() => r("waiting"), 300))]);
      expect(stillWaiting).toBe("waiting");

      await first.query("COMMIT");
      expect(await secondInsert).toMatch(/would exceed authorization/);
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }

    const rows = await handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.authorizationId, shared.id));
    expect(rows.map((r) => r.amountCents)).toEqual([60_000]);
  });
});
