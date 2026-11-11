import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { AiStage, AiState, CaseKey, ChangeDraft, HumanActor } from "./types";
import type { MoneyAnswer } from "../ai/money-types";
import type { ProjectQuote, ProjectStart } from "../projects/settings";
import type { QuoteAnswer } from "../ai/quote-query";
import { users } from "../auth/schema";

/**
 * A studio's project: its chat, and what it is set up as. `sessionId` is the
 * owning studio's id; `projectKey` is the project's short name, unique in the studio.
 */
export const chatCases = pgTable("chat_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  projectKey: text("project_key").$type<CaseKey>().notNull(),
  name: text("name").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  /** Whether V1 is a draft the designer sends from the chat, or was approved before Setti. */
  startsFrom: text("starts_from").$type<ProjectStart>().notNull(),
  /** The project's own V1: the lines being prepared, or the quote approved before Setti. */
  quote: jsonb("quote").$type<ProjectQuote>().notNull(),
  draft: jsonb("draft").$type<ChangeDraft>(),
  activeMessageId: uuid("active_message_id"),
  activeRunId: uuid("active_run_id"),
  activeRunStartedAt: timestamp("active_run_started_at", { withTimezone: true }),
  /** What the running reply is doing now, for the waiting client; cleared with the run. */
  activeRunStage: text("active_run_stage").$type<AiStage>(),
  latestCompletedSequence: integer("latest_completed_sequence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("chat_cases_session_project_unique").on(t.sessionId, t.projectKey),
  check("chat_cases_project_key_format", sql`${t.projectKey} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.projectKey}) <= 48`),
  check("chat_cases_starts_from_valid", sql`${t.startsFrom} IN ('draft_quote', 'approved_quote')`),
  check("chat_cases_active_run_complete", sql`(${t.activeMessageId} IS NULL AND ${t.activeRunId} IS NULL AND ${t.activeRunStartedAt} IS NULL) OR (${t.activeMessageId} IS NOT NULL AND ${t.activeRunId} IS NOT NULL AND ${t.activeRunStartedAt} IS NOT NULL)`),
]);

/** The people who open a project as its client. Studio members see every project of their studio; a client sees only these. */
export const projectClients = pgTable("project_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => chatCases.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("project_clients_one_per_user").on(t.caseId, t.userId)]);

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
  moneyAnswer: jsonb("money_answer").$type<MoneyAnswer>(),
  /** A quote lookup's matching lines, computed by the server from the approved quote. */
  quoteAnswer: jsonb("quote_answer").$type<QuoteAnswer>(),
  /** The V1 line a message asks about, shown as a tag that opens that line. */
  aboutItemId: text("about_item_id"),
  lastRunId: uuid("last_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.caseId, t.id] }),
  unique("chat_messages_case_reply_unique").on(t.caseId, t.replyToMessageId),
  check("chat_messages_actor_valid", sql`${t.actor} IN ('designer', 'client', 'assistant')`),
  check("chat_messages_ai_state_valid", sql`${t.aiState} IN ('none', 'running', 'completed', 'failed')`),
  check("chat_messages_text_not_empty", sql`length(btrim(${t.text})) > 0`),
]);
