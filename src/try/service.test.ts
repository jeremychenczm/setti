import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../approval/store";
import { createChatStore } from "../chat/store";
import { changeOrders, paymentOperations, paypalCaptures } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { TestCardApproval } from "../payments/paypal";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { trySeeds } from "./schema";
import { openWillowWorkspace, prepareTry, readTryRuns, readTrySeed, resumeTry, startTry, type TryDeps, type TrySeed } from "./service";

describe.skipIf(!testDatabaseUrl)("/try durable preparation with fake PayPal", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let paypal: FakePayPal;
  let approvals: string[];
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "try_seeds");
    paypal = new FakePayPal(); approvals = [];
  });
  afterAll(() => handle?.pool.end());
  const deps = (overrides: Partial<TryDeps> = {}): TryDeps => ({
    db: handle.db, paypal, links, perHour: 30,
    testCard: (orderId, options) => { approvals.push(orderId); return paypal.confirmWithTestCard(orderId, options); }, ...overrides,
  });
  async function allocate(visitorId = randomUUID()) {
    const result = await startTry(deps(), null, { visitorId });
    if (result.kind === "limited") throw new Error("Expected allocated run");
    return result;
  }
  async function step(runId: string, options: Partial<TryDeps> = {}) {
    const result = await prepareTry(deps(options), runId, runId);
    if (result.kind === "not_found") throw new Error("Expected saved run");
    return result;
  }
  async function finish(runId: string, options: Partial<TryDeps> = {}): Promise<TrySeed> {
    for (let index = 0; index < 8; index++) {
      const result = await step(runId, options);
      if (result.kind === "ready") return result.seed;
      if (result.kind === "failed") throw new Error("Unexpected preparation failure: " + JSON.stringify(await handle.db.select().from(trySeeds)));
    }
    throw new Error("Preparation did not finish");
  }

  it("persists identity and pending stages before creating quotes or provider money", async () => {
    const run = await allocate();
    expect(run).toMatchObject({ kind: "started", reused: false, seed: { runId: run.session, status: "seeding", stage: "quote", busy: false, canResume: true } });
    expect(run.seed.stages).toHaveLength(6);
    expect(run.seed.stages.every((stage) => stage.status === "pending")).toBe(true);
    expect(await handle.db.select().from(trySeeds)).toHaveLength(1);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
    expect(paypal.calls).toHaveLength(0);
    expect(await readTrySeed(handle.db, run.session)).toEqual(run.seed);
    expect(await startTry(deps(), run.session, { visitorId: run.visitorId })).toMatchObject({ session: run.session, reused: true });
    expect(paypal.calls).toHaveLength(0);
  });

  it("advances actual persisted stages into an $800 hold and $300 capture, then never seeds ready runs again", async () => {
    const run = await allocate();
    const quote = await step(run.session);
    expect(quote).toMatchObject({ kind: "progress", seed: { stage: "chair_hold", changeOrderId: expect.any(String) } });
    expect(quote.seed.stages[0].status).toBe("done");
    expect(paypal.calls).toHaveLength(0);
    const ready = await finish(run.session);
    expect(ready.status).toBe("ready");
    expect(ready.stages.every((stage) => stage.status === "done")).toBe(true);
    expect(approvals).toHaveLength(2);
    const operations = await handle.db.select().from(paymentOperations);
    const ledger = await readLedger(handle.db, operations[0].projectId);
    expect(ledger.authorizations.map((hold) => hold.amountCents).sort()).toEqual([30_000, 80_000]);
    expect(ledger.captures.map((capture) => [capture.amountCents, capture.status])).toEqual([[30_000, "completed"]]);
    expect(operations.every((operation) => operation.status === "succeeded")).toBe(true);
    expect(ready.stages.flatMap((stage) => stage.operationIds).sort()).toEqual(operations.map((operation) => operation.id).sort());
    expect(await handle.db.select().from(changeOrders)).toHaveLength(1);
    const calls = paypal.calls.length;
    expect(await startTry(deps({ perHour: 0 }), run.session, { visitorId: run.visitorId })).toMatchObject({ kind: "ready", reused: true, session: run.session });
    expect((await step(run.session)).kind).toBe("ready");
    expect(paypal.calls).toHaveLength(calls);
  });

  it.each(["lose-response", "answer-minimal"] as const)("resumes a %s order answer using the original authorization operation", async (behaviour) => {
    const run = await allocate();
    await step(run.session);
    paypal.then(behaviour);
    const first = await step(run.session);
    if (first.kind === "failed") expect(first.seed).toMatchObject({ stage: "chair_hold", canResume: true });
    const [original] = await handle.db.select().from(paymentOperations);
    const ready = await finish(run.session);
    expect(ready.status).toBe("ready");
    const operations = await handle.db.select().from(paymentOperations);
    expect(operations.filter((operation) => operation.kind === "authorize")).toHaveLength(2);
    expect(operations.find((operation) => operation.id === original.id)?.status).toBe("succeeded");
    const requests = paypal.calls.filter((call) => "referenceId" in call && call.amountCents === 80_000);
    expect(new Set(requests.map((call) => call.requestId)).size).toBe(1);
  });

  it("recovers a lost authorize answer without test-card approval or authorization of another order", async () => {
    const run = await allocate();
    await step(run.session);
    paypal.then("succeed", "lose-response");
    expect((await step(run.session)).kind).toBe("failed");
    const [original] = await handle.db.select().from(paymentOperations);
    expect(original).toMatchObject({ status: "unknown", paypalOrderId: expect.any(String) });
    expect(approvals).toHaveLength(1);
    await step(run.session);
    expect(approvals).toHaveLength(1);
    expect((await handle.db.select().from(paymentOperations))[0]).toMatchObject({ id: original.id, status: "succeeded", paypalOrderId: original.paypalOrderId });
    expect(paypal.calls.filter((call) => "orderId" in call)).toHaveLength(1);
  });

  it("resumes the original rug capture after a lost answer without capturing twice", async () => {
    const run = await allocate();
    for (let index = 0; index < 4; index++) await step(run.session);
    paypal.then("lose-response");
    expect((await step(run.session)).seed).toMatchObject({ status: "failed", stage: "rug_capture", canResume: true });
    const [original] = (await handle.db.select().from(paymentOperations)).filter((operation) => operation.kind === "capture");
    await finish(run.session);
    const captures = await handle.db.select().from(paypalCaptures);
    expect(captures).toEqual([expect.objectContaining({ operationId: original.id, amountCents: 30_000, status: "completed" })]);
    expect(new Set(paypal.calls.filter((call) => "paypalAuthorizationId" in call).map((call) => call.requestId)).size).toBe(1);
  });

  it("does not call a pending rug capture ready until the original capture is read back completed", async () => {
    const run = await allocate();
    for (let index = 0; index < 4; index++) await step(run.session);
    paypal.then("answer-pending");
    expect((await step(run.session)).seed).toMatchObject({ status: "failed", stage: "rug_capture", canResume: true });
    const [pending] = await handle.db.select().from(paypalCaptures);
    const writes = paypal.calls.length;
    paypal.settleCapture(pending.paypalCaptureId, "COMPLETED");
    await finish(run.session);
    expect(paypal.calls).toHaveLength(writes);
    expect((await handle.db.select().from(paypalCaptures))[0].status).toBe("completed");
  });

  it("exposes a live lease and lets a second request wait without repeating the provider operation", async () => {
    const run = await allocate();
    await step(run.session);
    let entered!: () => void, release!: () => void;
    const atApproval = new Promise<void>((resolve) => { entered = resolve; });
    const resumeApproval = new Promise<void>((resolve) => { release = resolve; });
    const testCard: TestCardApproval = async (orderId) => { entered(); await resumeApproval; return paypal.confirmWithTestCard(orderId); };
    const first = step(run.session, { testCard });
    await atApproval;
    expect(await readTrySeed(handle.db, run.session)).toMatchObject({ busy: true, canResume: false, stage: "chair_hold", stages: expect.arrayContaining([expect.objectContaining({ id: "chair_hold", status: "running" })]) });
    expect((await step(run.session)).kind).toBe("busy");
    expect(await startTry(deps(), run.session, { restart: true, visitorId: run.visitorId })).toMatchObject({ session: run.session, reused: true });
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
    release();
    expect((await first).kind).toBe("progress");
  });

  it("reconciles a stale stage from saved money after a worker stopped before recording progress", async () => {
    const run = await allocate();
    await step(run.session);
    const held = await step(run.session);
    const writes = paypal.calls.length;
    await handle.db.update(trySeeds).set({
      stages: held.seed.stages.map((stage) => stage.id === "chair_hold" ? { ...stage, status: "running" } : stage),
      leaseId: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1),
    }).where(eq(trySeeds.sessionId, run.session));
    expect((await step(run.session)).kind).toBe("progress");
    expect(paypal.calls).toHaveLength(writes);
    expect((await handle.db.select().from(paymentOperations))).toHaveLength(1);
  });

  it("upgrades a legacy failed run with no stages by reusing its V2 and existing money", async () => {
    const run = await allocate();
    await step(run.session); await step(run.session);
    const writes = paypal.calls.length;
    await handle.db.update(trySeeds).set({ status: "failed", stages: [], visitorId: null, changeOrderId: null, error: "Old worker stopped" }).where(eq(trySeeds.sessionId, run.session));
    await startTry(deps(), run.session, { visitorId: run.visitorId });
    await step(run.session); await step(run.session);
    expect(paypal.calls).toHaveLength(writes);
    await finish(run.session);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(1);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(3);
  });

  it("keeps old funds revisitable across restart, including a ready legacy run without visitor identity", async () => {
    const first = await allocate(), ready = await finish(first.session);
    await handle.db.update(trySeeds).set({ visitorId: null, stages: [] }).where(eq(trySeeds.sessionId, first.session));
    const writes = paypal.calls.length;
    const second = await startTry(deps(), first.session, { restart: true, visitorId: first.visitorId });
    if (second.kind === "limited") throw new Error("Expected replacement identity");
    expect(second.session).not.toBe(first.session);
    expect(paypal.calls).toHaveLength(writes);
    expect(await readTryRuns(handle.db, first.visitorId, second.session)).toEqual([expect.objectContaining({ runId: first.session, status: "ready", changeOrderId: ready.changeOrderId })]);
    expect(await resumeTry(handle.db, first.visitorId, first.session)).toMatchObject({ status: "ready", runId: first.session });
    expect(await resumeTry(handle.db, randomUUID(), first.session)).toBeNull();
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(3);
  });

  it("enforces the hourly cap atomically across visitors, while reusing a saved run costs no new slot", async () => {
    const starts = await Promise.all([startTry(deps({ perHour: 1 }), null), startTry(deps({ perHour: 1 }), null)]);
    expect(starts.map((result) => result.kind).sort()).toEqual(["limited", "started"]);
    const saved = starts.find((result) => result.kind === "started")!;
    if (saved.kind === "limited") throw new Error("Expected saved identity");
    expect(await startTry(deps({ perHour: 0 }), saved.session)).toMatchObject({ reused: true });
    expect(paypal.calls).toHaveLength(0);
  });

  it("stops on a terminal card rejection and never creates a replacement payment operation on retry", async () => {
    const run = await allocate();
    await step(run.session);
    const testCard: TestCardApproval = async () => ({ kind: "rejected", code: "CARD_REJECTED", message: "Declined" });
    expect((await step(run.session, { testCard })).seed).toMatchObject({ status: "failed", canResume: false });
    const writes = paypal.calls.length;
    expect((await step(run.session)).kind).toBe("failed");
    expect(paypal.calls).toHaveLength(writes);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(1);
    expect((await readTrySeed(handle.db, run.session))?.error).not.toContain("CARD_REJECTED");
  });

  it("prepares Willow's sent V1 once through the designer action, without approving lines or moving money", async () => {
    const session = await openWillowWorkspace(handle.db, null);
    const chat = createChatStore(handle.db);
    const sent = await chat.getCase(session, "willow");
    expect(sent.opening).toMatchObject({ status: "sent", progress: { approved: 0, pending: 26 } });
    expect(await openWillowWorkspace(handle.db, session)).toBe(session);
    expect((await chat.getCase(session, "willow")).messages).toHaveLength(1);
    expect(await handle.db.select().from(trySeeds)).toHaveLength(0);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
    expect(paypal.calls).toHaveLength(0);
    const maple = await startTry(deps(), session);
    expect(maple.kind !== "limited" && maple.session).toBe(session);
  });

  it("refuses another run identity before doing any work", async () => {
    const run = await allocate();
    expect(await prepareTry(deps(), randomUUID(), run.session)).toEqual({ kind: "not_found" });
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect(paypal.calls).toHaveLength(0);
  });
});
