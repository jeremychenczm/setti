import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../approval/store";
import { paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { TestCardApproval } from "../payments/paypal";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { trySeeds } from "./schema";
import { readTrySeed, startTry, type TryDeps } from "./service";

describe.skipIf(!testDatabaseUrl)("/try seeding on the fake PayPal", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let paypal: FakePayPal;
  let approvals: string[];
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "try_seeds");
    paypal = new FakePayPal();
    approvals = [];
  });
  afterAll(() => handle?.pool.end());

  const deps = (overrides: Partial<TryDeps> = {}): TryDeps => ({
    db: handle.db, paypal, links, perHour: 30,
    testCard: (orderId) => { approvals.push(orderId); return paypal.confirmWithTestCard(orderId); },
    ...overrides,
  });

  it("seeds a fresh session: the chair is held and the rug is captured, both approved by the test card", async () => {
    const result = await startTry(deps(), null);
    if (result.kind !== "ready") throw new Error(`Expected a ready seed, got ${result.kind}`);
    expect(result.reused).toBe(false);
    expect(approvals).toHaveLength(2);

    const operations = await handle.db.select().from(paymentOperations);
    const ledger = await readLedger(handle.db, operations[0].projectId);
    expect(ledger.authorizations.map((hold) => hold.amountCents).sort()).toEqual([30_000, 80_000]);
    expect(ledger.captures.map((capture) => [capture.amountCents, capture.status])).toEqual([[30_000, "completed"]]);
    expect(operations.every((operation) => operation.status === "succeeded")).toBe(true);
    expect(paypal.reads).toContain(ledger.captures[0].paypalCaptureId);
    expect(await readTrySeed(handle.db, result.session)).toMatchObject({ status: "ready", changeOrderId: result.changeOrderId });
  });

  it("brings a returning visitor back to their project without calling PayPal again", async () => {
    const first = await startTry(deps(), null);
    if (first.kind !== "ready") throw new Error("Expected a ready seed");
    const calls = paypal.calls.length;
    expect(await startTry(deps(), first.session)).toEqual({ kind: "ready", session: first.session, changeOrderId: first.changeOrderId, reused: true });
    expect(paypal.calls).toHaveLength(calls);
  });

  it("starts over in a new session when the visitor asks", async () => {
    const first = await startTry(deps(), null);
    if (first.kind !== "ready") throw new Error("Expected a ready seed");
    const again = await startTry(deps(), first.session, { restart: true });
    expect(again).toMatchObject({ kind: "ready", reused: false });
    expect(again.kind === "ready" && again.session).not.toBe(first.session);
  });

  it("stops seeding once the hourly limit is reached, counting failed seeds too", async () => {
    await handle.db.insert(trySeeds).values({ sessionId: randomUUID(), status: "failed", error: "earlier failure" });
    expect(await startTry(deps({ perHour: 2 }), null)).toMatchObject({ kind: "ready" });
    const calls = paypal.calls.length;
    expect(await startTry(deps({ perHour: 2 }), null)).toEqual({ kind: "limited" });
    expect(paypal.calls).toHaveLength(calls);
    const now = new Date(Date.now() + 61 * 60_000);
    expect(await startTry(deps({ perHour: 2, now: () => now }), null)).toMatchObject({ kind: "ready" });
  });

  it("does not seed twice while the visitor's seed is still running, but replaces an abandoned one", async () => {
    const session = randomUUID();
    await handle.db.insert(trySeeds).values({ sessionId: session });
    expect(await startTry(deps(), session)).toEqual({ kind: "busy" });
    expect(await startTry(deps(), session, { restart: true })).toEqual({ kind: "busy" });
    await handle.db.update(trySeeds).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(trySeeds.sessionId, session));
    expect(await startTry(deps(), session)).toMatchObject({ kind: "ready", reused: false });
  });

  it("records a failed seed when PayPal refuses the test card", async () => {
    const refused: TestCardApproval = async () => ({ kind: "rejected", code: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed." });
    const result = await startTry(deps({ testCard: refused }), null);
    expect(result).toEqual({ kind: "failed", message: expect.stringMatching(/Authorize the lounge chair.*Sandbox test card.*could not be performed/) });
    const [row] = await handle.db.select().from(trySeeds);
    expect(row).toMatchObject({ status: "failed", changeOrderId: null, error: expect.stringContaining("Sandbox test card") });
  });

  it("goes on when the card confirmation's answer was lost but PayPal shows the order approved", async () => {
    const lost: TestCardApproval = async (orderId) => { paypal.approve(orderId); return { kind: "unknown", message: "Timed out waiting for PayPal" }; };
    expect(await startTry(deps({ testCard: lost }), null)).toMatchObject({ kind: "ready" });
  });
});
