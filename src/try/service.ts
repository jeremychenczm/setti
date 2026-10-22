/**
 * /try: each visitor gets a fresh session whose Maple project already has money
 * on PayPal Sandbox (see maple.ts). The seeded orders are approved with the
 * Sandbox test card, so there is no buyer step; everything after that is the
 * app's normal flow.
 */
import { randomUUID } from "node:crypto";
import { count, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import type { LinkBuilder } from "../payments/actions";
import { refreshRecordedFees } from "../payments/fee-refresh";
import type { PayPalPayments, TestCardApproval } from "../payments/paypal";
import { mapleRun, startMaple } from "./maple";
import { trySeeds, type TrySeedStatus } from "./schema";

export interface TryDeps {
  db: Db;
  paypal: PayPalPayments;
  testCard: TestCardApproval;
  links: LinkBuilder;
  /** New seeds allowed across all visitors in any hour. */
  perHour: number;
  now?: () => Date;
}

export interface TrySeed {
  status: TrySeedStatus;
  changeOrderId: string | null;
  createdAt: Date;
}

export type TryStart =
  | { kind: "ready"; session: string; changeOrderId: string; reused: boolean }
  | { kind: "busy" }
  | { kind: "limited" }
  | { kind: "failed"; message: string };

/** A seed still running after this long is treated as abandoned. */
const STALE_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

export async function readTrySeed(db: Pick<Db, "select">, session: string | null): Promise<TrySeed | null> {
  if (!session) return null;
  const [row] = await db.select({ status: trySeeds.status, changeOrderId: trySeeds.changeOrderId, createdAt: trySeeds.createdAt }).from(trySeeds).where(eq(trySeeds.sessionId, session));
  return row ?? null;
}

/** Reuses the visitor's ready project unless they start over; otherwise seeds a new session. */
export async function startTry(deps: TryDeps, current: string | null, { restart = false } = {}): Promise<TryStart> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const existing = await readTrySeed(db, current);
  if (existing?.status === "ready" && !restart) return { kind: "ready", session: current!, changeOrderId: existing.changeOrderId!, reused: true };
  if (existing?.status === "seeding" && now.getTime() - existing.createdAt.getTime() < STALE_MS) return { kind: "busy" };

  const [recent] = await db.select({ value: count() }).from(trySeeds).where(gt(trySeeds.createdAt, new Date(now.getTime() - HOUR_MS)));
  if (recent.value >= deps.perHour) return { kind: "limited" };

  const session = randomUUID();
  await db.insert(trySeeds).values({ sessionId: session, createdAt: now, updatedAt: now });
  try {
    const order = await startMaple({ ...deps, approve: (_url, orderId, label) => approveWithTestCard(deps, orderId, label) }, mapleRun(session));
    // A capture's first answer can come without PayPal's fee; read it back so the project opens with it.
    await refreshRecordedFees(db, deps.paypal, session, order.id).catch(() => {});
    await db.update(trySeeds).set({ status: "ready", changeOrderId: order.id, updatedAt: new Date() }).where(eq(trySeeds.sessionId, session));
    return { kind: "ready", session, changeOrderId: order.id, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(trySeeds).set({ status: "failed", error: message.slice(0, 1_000), updatedAt: new Date() }).where(eq(trySeeds.sessionId, session));
    return { kind: "failed", message };
  }
}

async function approveWithTestCard(deps: TryDeps, orderId: string, label: string): Promise<void> {
  const result = await deps.testCard(orderId);
  if (result.kind === "ok" && result.value.status === "APPROVED") return;
  // A confirmation whose answer was lost may still have gone through; PayPal's order status decides.
  const order = await deps.paypal.getOrder(orderId);
  if (order.kind === "ok" && order.value.status === "APPROVED") return;
  throw new Error(`${label}: PayPal did not approve the order with the Sandbox test card (${result.kind === "ok" ? result.value.status ?? "no status" : result.message}).`);
}
