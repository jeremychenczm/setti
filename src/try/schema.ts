import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { changeOrders } from "../pricing/schema";

export type TrySeedStatus = "seeding" | "ready" | "failed";
export type TryStageId = "quote" | "chair_hold" | "rug_hold" | "supplier" | "rug_capture" | "fees"
  | "design_services" | "sofa_hold" | "coffee_table_hold" | "dining_table_hold" | "dining_chairs_hold" | "sideboard_hold" | "sideboard_supplier" | "sideboard_capture" | "discussion";
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
  check("try_seeds_ready_has_order", sql`${t.status} <> 'ready' OR ${t.changeOrderId} IS NOT NULL OR (${t.scenario} = 'maple-living-dining-v3' AND ${t.scenarioVersion} = 3)`),
  check("try_seeds_scenario_version_positive", sql`${t.scenarioVersion} > 0`),
  check("try_seeds_lease_complete", sql`(${t.leaseId} IS NULL) = (${t.leaseExpiresAt} IS NULL)`),
  index("try_seeds_created_at").on(t.createdAt),
  index("try_seeds_visitor_id").on(t.visitorId),
]);
