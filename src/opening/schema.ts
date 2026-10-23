import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chatCases, chatMessages } from "../chat/schema";
import type { QuoteDocument } from "../quotes/types";

/**
 * The V1 a designer sent from a project chat, frozen as sent. One per demo case;
 * the database refuses any change or deletion (see the opening-quote migration).
 */
export const openingQuotes = pgTable("opening_quotes", {
  caseId: uuid("case_id").primaryKey().references(() => chatCases.id),
  /** The designer's chat message that carries the quote card. */
  messageId: uuid("message_id").notNull(),
  version: integer("version").notNull().default(1),
  document: jsonb("document").$type<QuoteDocument>().notNull(),
  /** SHA-256 of the canonical document; a later approval must carry it. */
  contentHash: text("content_hash").notNull(),
  sentBy: text("sent_by").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.caseId, t.messageId], foreignColumns: [chatMessages.caseId, chatMessages.id], name: "opening_quotes_message_fk" }),
  check("opening_quotes_first_version", sql`${t.version} = 1`),
  check("opening_quotes_hash_format", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
]);

/**
 * A V1 line the designer dropped because the client declined it or never
 * decided on it. It leaves the project without a client signature, since it was
 * never part of the agreement. A record: never changed or deleted.
 */
export const openingWithdrawals = pgTable("opening_withdrawals", {
  caseId: uuid("case_id").notNull().references(() => chatCases.id),
  itemId: text("item_id").notNull(),
  withdrawnBy: text("withdrawn_by").notNull(),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.caseId, t.itemId] })]);
