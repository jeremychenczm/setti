import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { changeOrders } from "../pricing/schema";

export type TrySeedStatus = "seeding" | "ready" | "failed";

/**
 * One /try visit: a fresh session whose Maple project is seeded with real
 * Sandbox money. The row is written before any PayPal call, so one visitor never
 * seeds twice at once and the hourly limit also counts seeds that failed.
 */
export const trySeeds = pgTable("try_seeds", {
  sessionId: uuid("session_id").primaryKey(),
  status: text("status").$type<TrySeedStatus>().notNull().default("seeding"),
  /** The confirmed version whose payments were seeded. */
  changeOrderId: uuid("change_order_id").references(() => changeOrders.id),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("try_seeds_status_valid", sql`${t.status} IN ('seeding', 'ready', 'failed')`),
  check("try_seeds_ready_has_order", sql`${t.status} <> 'ready' OR ${t.changeOrderId} IS NOT NULL`),
  index("try_seeds_created_at").on(t.createdAt),
]);
