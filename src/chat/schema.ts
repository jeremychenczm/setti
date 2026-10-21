import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { AiState, CaseKey, ChangeDraft, HumanActor } from "./types";

/** Demo conversations are independent of real projects, quotes and payments. */
export const chatCases = pgTable("chat_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  projectKey: text("project_key").$type<CaseKey>().notNull(),
  draft: jsonb("draft").$type<ChangeDraft>(),
  activeMessageId: uuid("active_message_id"),
  activeRunId: uuid("active_run_id"),
  activeRunStartedAt: timestamp("active_run_started_at", { withTimezone: true }),
  latestCompletedSequence: integer("latest_completed_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("chat_cases_session_project_unique").on(t.sessionId, t.projectKey),
  check("chat_cases_project_key_valid", sql`${t.projectKey} IN ('willow', 'maple')`),
  check("chat_cases_active_run_complete", sql`(${t.activeMessageId} IS NULL AND ${t.activeRunId} IS NULL AND ${t.activeRunStartedAt} IS NULL) OR (${t.activeMessageId} IS NOT NULL AND ${t.activeRunId} IS NOT NULL AND ${t.activeRunStartedAt} IS NOT NULL)`),
]);

export const chatMessages = pgTable("chat_messages", {
  caseId: uuid("case_id").notNull().references(() => chatCases.id, { onDelete: "cascade" }),
  /** Client UUIDs are scoped to a case; they cannot identify another session's message. */
  id: uuid("id").notNull(),
  sequence: serial("sequence").notNull(),
  actor: text("actor").$type<HumanActor | "assistant">().notNull(),
  text: text("text").notNull(),
  replyToMessageId: uuid("reply_to_message_id"),
  aiState: text("ai_state").$type<AiState>().notNull().default("none"),
  error: text("error"),
  model: text("model"),
  lastRunId: uuid("last_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.caseId, t.id] }),
  unique("chat_messages_case_reply_unique").on(t.caseId, t.replyToMessageId),
  check("chat_messages_actor_valid", sql`${t.actor} IN ('designer', 'client', 'assistant')`),
  check("chat_messages_ai_state_valid", sql`${t.aiState} IN ('none', 'running', 'completed', 'failed')`),
  check("chat_messages_text_not_empty", sql`length(btrim(${t.text})) > 0`),
]);
