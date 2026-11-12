import { sql } from "drizzle-orm";
import { check, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "../auth/schema";

/** How many AI requests each real account has made; the demo's visitors are not counted here. */
export const aiAllowances = pgTable("ai_allowances", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  used: integer("used").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check("ai_allowances_used_positive", sql`${table.used} > 0`)]);
