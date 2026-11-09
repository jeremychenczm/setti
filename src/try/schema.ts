import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { changeOrders } from "../pricing/schema";

export type TrySeedStatus = "seeding" | "ready" | "failed";
export type TryStageId = "quote" | "chair_hold" | "rug_hold" | "supplier" | "rug_capture" | "fees"
  | "starting_payments" | "countertop_supplier" | "countertop_capture" | "wall_tile_supplier" | "wall_tile_capture" | "discussion";
export interface TryStage {
  id: TryStageId;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  operationIds: string[];
}

/**
 * One /try visit: a fresh session whose Maple project is seeded with real
 * Sandbox money. The row is written before any PayPal call, so one visitor never
 * seeds twice at once and the hourly limit also counts seeds that failed.
 */
export const trySeeds = pgTable("try_seeds", {
  sessionId: uuid("session_id").primaryKey(),
  /** Stable private visitor identity; a new run never makes an older run unreachable. */
  visitorId: uuid("visitor_id"),
  scenario: text("scenario").notNull().default("maple-mixed-change-v1"),
  scenarioVersion: integer("scenario_version").notNull().default(1),
  status: text("status").$type<TrySeedStatus>().notNull().default("seeding"),
  stages: jsonb("stages").$type<TryStage[]>().notNull().default(sql`'[]'::jsonb`),
  leaseId: uuid("lease_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  recoverable: boolean("recoverable").notNull().default(true),
  /** Legacy prepared change order; null for the genuine opening-V1 scenario. */
  changeOrderId: uuid("change_order_id").references(() => changeOrders.id),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("try_seeds_status_valid", sql`${t.status} IN ('seeding', 'ready', 'failed')`),
  check("try_seeds_ready_has_order", sql`${t.status} <> 'ready' OR ${t.changeOrderId} IS NOT NULL OR (${t.scenario} = 'maple-living-dining-v3' AND ${t.scenarioVersion} IN (3, 4))`),
  check("try_seeds_scenario_version_positive", sql`${t.scenarioVersion} > 0`),
  check("try_seeds_lease_complete", sql`(${t.leaseId} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
  index("try_seeds_created_at").on(t.createdAt),
  index("try_seeds_visitor_id").on(t.visitorId),
]);

export type DemoEndReason = "idle" | "visitor";

/**
 * When a demo session was last used, and whether it has ended. Any request with
 * the session's cookie counts as use (noted at most once an hour). A demo ends
 * after IDLE_DAYS without use, or when its visitor ends it; its open holds are
 * then released and the project stays as a read-only record.
 */
export const demoActivity = pgTable("demo_activity", {
  sessionId: uuid("session_id").primaryKey(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason").$type<DemoEndReason>(),
}, (t) => [
  check("demo_activity_end", sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL) AND (${t.endReason} IS NULL OR ${t.endReason} IN ('idle', 'visitor'))`),
  index("demo_activity_last_active_at").on(t.lastActiveAt),
]);

/**
 * How far a demo session has skipped ahead, in whole days. Its reminders,
 * notices and renewals are worked out as if that much time had passed, so a
 * visitor can see what happens on day 3 or day 25 of a hold. PayPal calls still
 * happen now, in the Sandbox; only the clock Setti judges by moves.
 */
export const demoClocks = pgTable("demo_clocks", {
  sessionId: uuid("session_id").primaryKey(),
  days: integer("days").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("demo_clocks_days", sql`${t.days} BETWEEN 0 AND 30`),
]);
