import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { revisions } from "../db/schema";
import { changeOrders } from "../pricing/schema";

/** A demo client's whole-document decision, bound to both immutable hashes. */
export const changeOrderDecisions = pgTable("change_order_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => changeOrders.id),
  revisionId: uuid("revision_id").notNull().references(() => revisions.id),
  sessionId: uuid("session_id").notNull(),
  decision: text("decision").$type<"approved" | "changes_requested">().notNull(),
  clientName: text("client_name").notNull(),
  signature: text("signature").notNull(),
  note: text("note").notNull().default(""),
  contentHash: text("content_hash").notNull(),
  revisionContentHash: text("revision_content_hash").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("change_order_decisions_one_per_order").on(t.orderId),
  unique("change_order_decisions_one_per_revision").on(t.revisionId),
  check("change_order_decisions_valid_decision", sql`${t.decision} IN ('approved', 'changes_requested')`),
  check("change_order_decisions_named", sql`length(trim(${t.signature})) > 0 AND ${t.signature} = ${t.clientName}`),
  check("change_order_decisions_changes_note", sql`${t.decision} <> 'changes_requested' OR length(trim(${t.note})) > 0`),
]);
