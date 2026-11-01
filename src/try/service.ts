/** Persist the private run before money, then advance one leased stage per request. */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { createChatStore } from "../chat/store";
import { HOME_LEGACY_SCENARIO, HOME_SCENARIO, HOME_SCENARIO_VERSION, isHomeScenario } from "../demo/living-dining";
import type { LinkBuilder } from "../payments/actions";
import { refreshRecordedFees } from "../payments/fee-refresh";
import type { PayPalPayments, TestCardApproval } from "../payments/paypal";
import { authorizeItem, captureMapleRug, capturePreparedItem, confirmSupplierOrder, ensureMapleQuote, MaplePreparationError, mapleRun } from "./maple";
import { appendHomeDiscussion, ensureHomeQuote, ensureHomeWorkspace } from "./home";
import { prepareHomeCapture, prepareHomeHold, prepareHomeServices, prepareHomeStartingPayments, prepareHomeSupplier, refreshHomeFees } from "./home-payments";
import { trySeeds, type TrySeedStatus, type TryStage } from "./schema";

export const MAPLE_SCENARIO = "maple-mixed-change-v1";
export type TryScenario = typeof MAPLE_SCENARIO | typeof HOME_SCENARIO | typeof HOME_LEGACY_SCENARIO;
export const TRY_PROJECT_HREF = "/chats/maple";
const LEASE_MS = 5 * 60_000, HOUR_MS = 60 * 60_000;
const homeHeldItems: Partial<Record<TryStage["id"], string>> = { sofa_hold: "sofa", coffee_table_hold: "coffee-table", dining_table_hold: "dining-table", dining_chairs_hold: "dining-chairs", sideboard_hold: "sideboard" };
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
  workspaceReady: boolean; baselineQuoteVersion: 1 | 2;
}
export interface TryRunSummary {
  runId: string; status: TrySeedStatus; changeOrderId: string | null; createdAt: Date; href: string;
}
export type TryStart = { kind: "ready" | "started"; session: string; visitorId: string; seed: TrySeed; reused: boolean } | { kind: "limited" };
export type TryPreparation = { kind: "ready" | "progress" | "busy" | "failed"; seed: TrySeed } | { kind: "not_found" };

function stages(scenario: string = MAPLE_SCENARIO): TryStage[] {
  const definitions = isHomeScenario(scenario) ? [
    ["quote", "Import the prepared $7,730 living-and-dining agreement"],
    // V1 pays the design fee and places all five holds at once; the older V2 story keeps one stage per hold.
    ...(scenario === HOME_SCENARIO ? [["starting_payments", "Pay the $1,000 design fee and place the five furniture holds ($6,730)"]] : [
      ["sofa_hold", "Place the $2,400 sofa hold"], ["coffee_table_hold", "Place the $650 coffee table hold"],
      ["dining_table_hold", "Place the $1,400 dining table hold"], ["dining_chairs_hold", "Place the $1,080 hold for six dining chairs"],
      ["sideboard_hold", "Place the $1,200 sideboard hold"],
    ]),
    ["sideboard_supplier", "Record the sideboard supplier confirmation (demo)"],
    ["sideboard_capture", "Capture the $1,200 sideboard payment"], ["fees", "Read the PayPal payment evidence"],
    ["discussion", "Save the living-and-dining discussion and demo supplier notes"],
  ] : [
    ["quote", "Confirm the prepared Maple quote"], ["chair_hold", "Place the $800 lounge chair hold"],
    ["rug_hold", "Place the $300 wool rug hold"], ["supplier", "Record the rug supplier confirmation (demo)"],
    ["rug_capture", "Capture the $300 wool rug payment"], ["fees", "Read the PayPal payment evidence"],
  ];
  return definitions.map(([id, label]) => ({ id: id as TryStage["id"], label, status: "pending", operationIds: [] }));
}
function savedStages(row: SeedRow): TryStage[] {
  if (row.stages.length) return row.stages;
  return stages(row.scenario).map((stage) => ({ ...stage, status: row.status === "ready" ? "done" : "pending" }));
}
function snapshot(row: SeedRow, now = new Date()): TrySeed {
  const progress = savedStages(row), current = progress.find((stage) => stage.status !== "done");
  const busy = !!row.leaseId && !!row.leaseExpiresAt && row.leaseExpiresAt > now;
  return {
    runId: row.sessionId, scenario: row.scenario, scenarioVersion: row.scenarioVersion, status: row.status,
    stage: current?.id ?? null, stages: progress, busy, canResume: row.status !== "ready" && !busy && row.recoverable,
    error: row.status !== "failed" ? null : row.recoverable
      ? "Preparing " + (current?.label ?? "the project") + " did not finish. Resume to check the same saved operations."
      : "This saved run needs review before preparation can continue. Starting another workspace does not undo its recorded payments.",
    changeOrderId: row.changeOrderId, createdAt: row.createdAt, updatedAt: row.updatedAt,
    workspaceReady: row.scenario === HOME_SCENARIO ? progress.some((stage) => stage.id === "quote" && stage.status === "done") && progress.some((stage) => stage.id === "discussion" && stage.status === "done") : row.status === "ready",
    baselineQuoteVersion: row.scenario === HOME_SCENARIO ? 1 : 2,
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
export async function startTry(deps: AllocationDeps, current: string | null, { restart = false, visitorId = randomUUID(), scenario }: { restart?: boolean; visitorId?: string; scenario?: TryScenario } = {}): Promise<TryStart> {
  const now = deps.now?.() ?? new Date();
  const result = await deps.db.transaction(async (tx): Promise<TryStart> => {
    await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(hashtext('setti-try-allocation'))"));
    const [existing] = current
      ? await tx.select().from(trySeeds).where(eq(trySeeds.sessionId, current)).for("update")
      : await tx.select().from(trySeeds).where(eq(trySeeds.visitorId, visitorId)).orderBy(desc(trySeeds.createdAt)).limit(1);
    const owner = existing?.visitorId ?? visitorId;
    // Claim a legacy run before creating a replacement, so its money remains revisitable.
    if (existing && !existing.visitorId) await tx.update(trySeeds).set({ visitorId: owner }).where(eq(trySeeds.sessionId, existing.sessionId));
    const switchScenario = scenario !== undefined && existing?.scenario !== scenario;
    if (existing && ((!restart && !switchScenario) || existing.leaseId && existing.leaseExpiresAt && existing.leaseExpiresAt > now)) {
      return { kind: existing.status === "ready" ? "ready" : "started", session: existing.sessionId, visitorId: owner, seed: snapshot(existing, now), reused: true };
    }
    const [recent] = await tx.select({ value: count() }).from(trySeeds).where(gt(trySeeds.createdAt, new Date(now.getTime() - HOUR_MS)));
    if (recent.value >= deps.perHour) return { kind: "limited" };
    const selected = scenario ?? MAPLE_SCENARIO;
    // A newly selected story cannot adopt an older, unseeded workspace's quote or money.
    const session = current && !existing && !isHomeScenario(selected) ? current : randomUUID();
    const [created] = await tx.insert(trySeeds).values({ sessionId: session, visitorId: owner, scenario: selected, scenarioVersion: selected === HOME_SCENARIO ? HOME_SCENARIO_VERSION : selected === HOME_LEGACY_SCENARIO ? 2 : 1, stages: stages(selected), createdAt: now, updatedAt: now }).returning();
    return { kind: "started", session, visitorId: owner, seed: snapshot(created, now), reused: false };
  });
  if (result.kind !== "limited" && result.seed.scenario === HOME_SCENARIO && !result.seed.workspaceReady) {
    await ensureHomeWorkspace(deps.db, result.session);
    const progress = result.seed.stages.map((stage): TryStage => stage.id === "quote" || stage.id === "discussion" ? { ...stage, label: stage.id === "quote" ? "Open the agreed V1 living-and-dining quote" : stage.label, status: "done" } : stage);
    await deps.db.update(trySeeds).set({ stages: progress, updatedAt: deps.now?.() ?? new Date() }).where(eq(trySeeds.sessionId, result.session));
    return { ...result, seed: (await readTrySeed(deps.db, result.session))! };
  }
  return result;
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
    const home = isHomeScenario(row.scenario), v1 = row.scenario === HOME_SCENARIO;
    if ((!home && row.scenario !== MAPLE_SCENARIO) || row.scenarioVersion !== (v1 ? HOME_SCENARIO_VERSION : home ? 2 : 1)) throw new MaplePreparationError("This saved scenario version is not supported by this server. No replacement payments were created.", false);
    let preparedOperations: string[] = [];
    if (v1) {
      await ensureHomeWorkspace(deps.db, session);
      const heldItem = homeHeldItems[stage.id];
      if (stage.id === "starting_payments") preparedOperations = await prepareHomeStartingPayments(deps, session, Object.values(homeHeldItems));
      // Runs saved before the starting payments ran together keep their one-hold stages.
      else if (heldItem) preparedOperations = await prepareHomeHold(deps, session, heldItem);
      else if (stage.id === "design_services") preparedOperations = await prepareHomeServices(deps, session);
      else if (stage.id === "sideboard_supplier") await prepareHomeSupplier(deps.db, session);
      else if (stage.id === "sideboard_capture") preparedOperations = await prepareHomeCapture(deps, session);
      else if (stage.id === "fees") await refreshHomeFees(deps, session);
      else if (!["quote", "discussion"].includes(stage.id)) throw new MaplePreparationError("The saved V1 stage is not supported.", false);
    } else {
      const initial = home ? await ensureHomeQuote(deps.db, session) : await ensureMapleQuote(deps.db, session);
      changeOrderId = initial.id;
      switch (stage.id) {
      case "quote": break;
      case "chair_hold": await authorizeItem(options, run, initial, "chair", "Authorize the lounge chair ($800.00)"); break;
      case "rug_hold": await authorizeItem(options, run, initial, "rug", "Authorize the wool rug ($300.00)"); break;
      case "supplier": await confirmSupplierOrder(deps.db, run, initial, "rug"); break;
      case "rug_capture": await captureMapleRug(options, run, initial); break;
      case "sofa_hold": await authorizeItem(options, run, initial, "sofa", "Authorize the sofa ($2,400.00)", "baseline"); break;
      case "coffee_table_hold": await authorizeItem(options, run, initial, "coffee-table", "Authorize the coffee table ($650.00)", "baseline"); break;
      case "dining_table_hold": await authorizeItem(options, run, initial, "dining-table", "Authorize the dining table ($1,400.00)", "baseline"); break;
      case "dining_chairs_hold": await authorizeItem(options, run, initial, "dining-chairs", "Authorize six dining chairs ($1,080.00)", "baseline"); break;
      case "sideboard_hold": await authorizeItem(options, run, initial, "sideboard", "Authorize the sideboard ($1,200.00)", "baseline"); break;
      case "sideboard_supplier": await confirmSupplierOrder(deps.db, run, initial, "sideboard", "baseline"); break;
      case "sideboard_capture": await capturePreparedItem(options, run, initial, "sideboard", "sideboard", "baseline"); break;
      case "fees": await refreshRecordedFees(deps.db, deps.paypal, session, initial.id); break;
      case "discussion": await appendHomeDiscussion(deps.db, session, initial); break;
      default: throw new MaplePreparationError("The saved preparation stage is not supported. No replacement payments were created.", false);
      }
    }
    const progress = row.stages.map((entry): TryStage => entry.id === stage.id
      ? { ...entry, status: "done", operationIds: v1 ? preparedOperations : run.steps.flatMap((step) => step.operations.map((operation) => operation.id)) } : entry);
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
