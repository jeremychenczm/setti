/** Persist the private run before money, then advance one leased stage per request. */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createChatStore } from "../chat/store";
import type { LinkBuilder } from "../payments/actions";
import { refreshRecordedFees } from "../payments/fee-refresh";
import type { PayPalPayments, TestCardApproval } from "../payments/paypal";
import { authorizeItem, captureMapleRug, confirmSupplierOrder, ensureMapleQuote, MaplePreparationError, mapleRun } from "./maple";
import { trySeeds, type TrySeedStatus, type TryStage } from "./schema";

export const MAPLE_SCENARIO = "maple-mixed-change-v1";
export const TRY_PROJECT_HREF = "/chats/maple";
const LEASE_MS = 5 * 60_000, HOUR_MS = 60 * 60_000;
export interface TryDeps {
  db: Db; paypal: PayPalPayments; testCard: TestCardApproval; links: LinkBuilder;
  perHour: number; now?: () => Date;
}
type AllocationDeps = Pick<TryDeps, "db" | "perHour" | "now">;
type SeedRow = typeof trySeeds.$inferSelect;
export interface TrySeed {
  runId: string; scenario: string; scenarioVersion: number; status: TrySeedStatus;
  stage: TryStage["id"] | null; stages: TryStage[]; busy: boolean; canResume: boolean;
  error: string | null; changeOrderId: string | null; createdAt: Date; updatedAt: Date;
}
export interface TryRunSummary {
  runId: string; status: TrySeedStatus; changeOrderId: string | null; createdAt: Date; href: string;
}
export type TryStart = { kind: "ready" | "started"; session: string; visitorId: string; seed: TrySeed; reused: boolean } | { kind: "limited" };
export type TryPreparation = { kind: "ready" | "progress" | "busy" | "failed"; seed: TrySeed } | { kind: "not_found" };

function stages(): TryStage[] {
  return [
    ["quote", "Confirm the prepared Maple quote"], ["chair_hold", "Place the $800 lounge chair hold"],
    ["rug_hold", "Place the $300 wool rug hold"], ["supplier", "Record the rug supplier confirmation (demo)"],
    ["rug_capture", "Capture the $300 wool rug payment"], ["fees", "Read the PayPal payment evidence"],
  ].map(([id, label]) => ({ id: id as TryStage["id"], label, status: "pending", operationIds: [] }));
}
function savedStages(row: SeedRow): TryStage[] {
  if (row.stages.length) return row.stages;
  return stages().map((stage) => ({ ...stage, status: row.status === "ready" ? "done" : "pending" }));
}
function snapshot(row: SeedRow, now = new Date()): TrySeed {
  const progress = savedStages(row), current = progress.find((stage) => stage.status !== "done");
  const busy = !!row.leaseId && !!row.leaseExpiresAt && row.leaseExpiresAt > now;
  return {
    runId: row.sessionId, scenario: row.scenario, scenarioVersion: row.scenarioVersion, status: row.status,
    stage: current?.id ?? null, stages: progress, busy, canResume: row.status !== "ready" && !busy && row.recoverable,
    error: row.status !== "failed" ? null : row.recoverable
      ? "Preparing " + (current?.label ?? "the project") + " did not finish. Resume to check the same saved operations."
      : "PayPal refused a saved payment step. This run needs review; a new workspace does not undo its recorded money.",
    changeOrderId: row.changeOrderId, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
export async function readTrySeed(db: Pick<Db, "select">, session: string | null, now = new Date()): Promise<TrySeed | null> {
  if (!session) return null;
  const [row] = await db.select().from(trySeeds).where(eq(trySeeds.sessionId, session));
  return row ? snapshot(row, now) : null;
}
export async function readTryRuns(db: Pick<Db, "select">, visitorId: string | null, current: string | null): Promise<TryRunSummary[]> {
  if (!visitorId) return [];
  const rows = await db.select().from(trySeeds).where(eq(trySeeds.visitorId, visitorId)).orderBy(desc(trySeeds.createdAt)).limit(20);
  return rows.filter((row) => row.sessionId !== current).map((row) => ({ runId: row.sessionId, status: row.status, changeOrderId: row.changeOrderId, createdAt: row.createdAt, href: TRY_PROJECT_HREF }));
}
/** This returns before any provider call, so the browser retains its private run identity. */
export async function startTry(deps: AllocationDeps, current: string | null, { restart = false, visitorId = randomUUID() }: { restart?: boolean; visitorId?: string } = {}): Promise<TryStart> {
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(hashtext('setti-try-allocation'))"));
    const [existing] = current
      ? await tx.select().from(trySeeds).where(eq(trySeeds.sessionId, current)).for("update")
      : await tx.select().from(trySeeds).where(eq(trySeeds.visitorId, visitorId)).orderBy(desc(trySeeds.createdAt)).limit(1);
    const owner = existing?.visitorId ?? visitorId;
    // Claim a legacy run before creating a replacement, so its money remains revisitable.
    if (existing && !existing.visitorId) await tx.update(trySeeds).set({ visitorId: owner }).where(eq(trySeeds.sessionId, existing.sessionId));
    if (existing && (!restart || existing.leaseId && existing.leaseExpiresAt && existing.leaseExpiresAt > now)) {
      return { kind: existing.status === "ready" ? "ready" : "started", session: existing.sessionId, visitorId: owner, seed: snapshot(existing, now), reused: true };
    }
    const [recent] = await tx.select({ value: count() }).from(trySeeds).where(gt(trySeeds.createdAt, new Date(now.getTime() - HOUR_MS)));
    if (recent.value >= deps.perHour) return { kind: "limited" };
    const session = current && !existing ? current : randomUUID();
    const [created] = await tx.insert(trySeeds).values({ sessionId: session, visitorId: owner, scenario: MAPLE_SCENARIO, scenarioVersion: 1, stages: stages(), createdAt: now, updatedAt: now }).returning();
    return { kind: "started", session, visitorId: owner, seed: snapshot(created, now), reused: false };
  });
}
export async function resumeTry(db: Db, visitorId: string | null, runId: string): Promise<TrySeed | null> {
  if (!visitorId) return null;
  const [row] = await db.select().from(trySeeds).where(and(eq(trySeeds.sessionId, runId), eq(trySeeds.visitorId, visitorId)));
  return row ? snapshot(row) : null;
}
/** Send the designer's V1 once. The client still makes every line decision. */
export async function openWillowWorkspace(db: Db, current: string | null): Promise<string> {
  const session = current ?? randomUUID(), chat = createChatStore(db);
  const state = await chat.getCase(session, "willow");
  if (state.opening?.status === "draft") await chat.sendQuote(session, "willow", {
    id: randomUUID(), text: "Here is quote V1 for your review. Choose the lines you approve before any payment.", sentBy: "Jordan Lee",
  });
  return session;
}
/** An expired lease resumes the same run and original provider operations. */
export async function prepareTry(deps: TryDeps, session: string, runId: string): Promise<TryPreparation> {
  if (session !== runId) return { kind: "not_found" };
  const now = deps.now?.() ?? new Date(), leaseId = randomUUID();
  const claim = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(trySeeds).where(eq(trySeeds.sessionId, session)).for("update");
    if (!row) return null;
    if (row.status === "ready" || !row.recoverable || row.leaseId && row.leaseExpiresAt && row.leaseExpiresAt > now) return { row, owned: false };
    const progress = savedStages(row), stage = progress.find((entry) => entry.status !== "done");
    if (!stage) return { row, owned: false };
    const [leased] = await tx.update(trySeeds).set({
      status: "seeding", error: null, leaseId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now,
      stages: progress.map((entry): TryStage => entry.id === stage.id ? { ...entry, status: "running" } : entry),
    }).where(eq(trySeeds.sessionId, session)).returning();
    return { row: leased, owned: true };
  });
  if (!claim) return { kind: "not_found" };
  if (!claim.owned) return { kind: claim.row.status === "ready" ? "ready" : !claim.row.recoverable ? "failed" : "busy", seed: snapshot(claim.row, now) };
  const row = claim.row, stage = row.stages.find((entry) => entry.status === "running")!;
  const run = mapleRun(session), options = { ...deps, approve: (_url: string, orderId: string, label: string) => approveWithTestCard(deps, orderId, label) };
  let changeOrderId = row.changeOrderId;
  try {
    const initial = await ensureMapleQuote(deps.db, session);
    changeOrderId = initial.id;
    switch (stage.id) {
      case "quote": break;
      case "chair_hold": await authorizeItem(options, run, initial, "chair", "Authorize the lounge chair ($800.00)"); break;
      case "rug_hold": await authorizeItem(options, run, initial, "rug", "Authorize the wool rug ($300.00)"); break;
      case "supplier": await confirmSupplierOrder(deps.db, run, initial, "rug"); break;
      case "rug_capture": await captureMapleRug(options, run, initial); break;
      case "fees": await refreshRecordedFees(deps.db, deps.paypal, session, initial.id); break;
    }
    const progress = row.stages.map((entry): TryStage => entry.id === stage.id
      ? { ...entry, status: "done", operationIds: run.steps.flatMap((step) => step.operations.map((operation) => operation.id)) } : entry);
    const ready = progress.every((entry) => entry.status === "done");
    await deps.db.update(trySeeds).set({ status: ready ? "ready" : "seeding", changeOrderId, stages: progress, leaseId: null, leaseExpiresAt: null, updatedAt: deps.now?.() ?? new Date() })
      .where(and(eq(trySeeds.sessionId, session), eq(trySeeds.leaseId, leaseId)));
  } catch (error) {
    await deps.db.update(trySeeds).set({
      status: "failed", changeOrderId, error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      recoverable: !(error instanceof MaplePreparationError) || error.recoverable,
      stages: row.stages.map((entry): TryStage => entry.id === stage.id ? { ...entry, status: "failed" } : entry),
      leaseId: null, leaseExpiresAt: null, updatedAt: deps.now?.() ?? new Date(),
    }).where(and(eq(trySeeds.sessionId, session), eq(trySeeds.leaseId, leaseId)));
  }
  const seed = (await readTrySeed(deps.db, session, deps.now?.() ?? new Date()))!;
  return { kind: seed.status === "ready" ? "ready" : seed.status === "failed" ? "failed" : "progress", seed };
}
async function approveWithTestCard(deps: TryDeps, orderId: string, label: string): Promise<void> {
  const result = await deps.testCard(orderId);
  if (result.kind === "ok" && (result.value.status === "APPROVED" || result.value.status === "COMPLETED")) return;
  const order = await deps.paypal.getOrder(orderId);
  if (order.kind === "ok" && (order.value.status === "APPROVED" || order.value.status === "COMPLETED")) return;
  throw new MaplePreparationError(label + ": PayPal did not approve the original order with the Sandbox test card.", result.kind !== "rejected");
}
