import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CaseMessage } from "@/chat/types";

/** Private continuations of the prepared histories, never payment receipts. */
export const studioThreads = pgTable("studio_threads", {
  sessionId: uuid("session_id").notNull(),
  projectId: text("project_id").notNull(),
  messages: jsonb("messages").$type<CaseMessage[]>().notNull().default([]),
  activeRunId: uuid("active_run_id"),
  activeSince: timestamp("active_since", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.projectId] }),
  check("studio_threads_messages_array", sql`jsonb_typeof(${t.messages}) = 'array'`),
  check("studio_threads_active_run_complete", sql`(${t.activeRunId} IS NULL) = (${t.activeSince} IS NULL)`),
]);
