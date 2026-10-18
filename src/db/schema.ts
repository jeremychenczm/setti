/**
 * Database schema. Money columns (added in later steps) are integer cents.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** One design project: a space for one client, with its own chat, items and money. */
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  space: text("space").notNull(),
  clientName: text("client_name").notNull(),
  clientEmail: text("client_email"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
