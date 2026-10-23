import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { chatCases } from "../chat/schema";
import { projects, revisions } from "../db/schema";
import type { DraftProposal, FrozenChangeOrder, PricingInput } from "./types";

/** A demo chat case acquires a separate business project only when a review is issued. */
export const pricingCases = pgTable("pricing_cases", {
  caseId: uuid("case_id").primaryKey().references(() => chatCases.id),
  projectId: uuid("project_id").notNull().unique().references(() => projects.id),
  baselineRevisionId: uuid("baseline_revision_id").notNull().references(() => revisions.id),
  baselineQuoteId: text("baseline_quote_id").notNull(),
  itemMapping: jsonb("item_mapping").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pricingReviews = pgTable("pricing_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().unique().references(() => chatCases.id),
  sourceDraftId: uuid("source_draft_id").notNull(),
  sourceDraftRevision: integer("source_draft_revision").notNull(),
  version: integer("version").notNull(),
  input: jsonb("input").$type<PricingInput>().notNull(),
  /** What the draft proposed when the review was saved; null on reviews saved before this was kept. */
  draftProposal: jsonb("draft_proposal").$type<DraftProposal>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("pricing_reviews_version_positive", sql`${t.version} > 0`),
  check("pricing_reviews_source_revision_positive", sql`${t.sourceDraftRevision} > 0`),
]);

/** Payloads are append-only; lifecycle status is read from the associated business revision. */
export const changeOrders = pgTable("change_orders", {
  id: uuid("id").primaryKey(),
  caseId: uuid("case_id").notNull().references(() => chatCases.id),
  reviewId: uuid("review_id").notNull().references(() => pricingReviews.id),
  reviewVersion: integer("review_version").notNull(),
  revisionId: uuid("revision_id").notNull().unique().references(() => revisions.id),
  contentHash: text("content_hash").notNull(),
  document: jsonb("document").$type<FrozenChangeOrder>().notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
}, (t) => [
  unique("change_orders_review_version_unique").on(t.reviewId, t.reviewVersion),
  check("change_orders_review_version_positive", sql`${t.reviewVersion} > 0`),
]);
