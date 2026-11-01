import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items, paymentOperations, paypalAuthorizations, projects, revisions } from "../db/schema";
import { changeOrders } from "../pricing/schema";
import type { CancellationReason } from "./cancellation";

/**
 * What the supplier confirmed, recorded by the designer for one business item
 * of one client-confirmed version: a change order, or a V1 the client signed
 * line by line (named by its revision). In this demo the designer enters it by
 * hand, so every event is labelled as a demo record. Append-only.
 * - `order_confirmed`: the supplier accepted the order on the confirmed terms; capture may follow.
 * - `credit_confirmed`: the supplier credited a return or cancellation; the refund may follow.
 */
export const supplierEvents = pgTable("supplier_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  changeOrderId: uuid("change_order_id").references(() => changeOrders.id),
  /** The signed V1 revision, when the event belongs to V1 rather than a change order. */
  revisionId: uuid("revision_id").references(() => revisions.id),
  itemId: uuid("item_id").notNull().references(() => items.id),
  kind: text("kind").$type<"order_confirmed" | "credit_confirmed">().notNull(),
  /** Supplier's confirmed terms for an order; null for a credit. */
  quantity: integer("quantity"),
  unitPriceCents: integer("unit_price_cents"),
  taxCents: integer("tax_cents"),
  freightCents: integer("freight_cents"),
  inStock: boolean("in_stock"),
  leadTimeDays: integer("lead_time_days"),
  /** The order total the supplier confirmed, or the amount the supplier credited. */
  totalCents: integer("total_cents").notNull(),
  /** Supplier confirmation or credit memo reference. */
  reference: text("reference").notNull(),
  note: text("note").notNull().default(""),
  isDemo: boolean("is_demo").notNull().default(true),
  sessionId: uuid("session_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_events_one_per_kind").on(t.changeOrderId, t.itemId, t.kind),
  unique("supplier_events_one_per_kind_on_v1").on(t.revisionId, t.itemId, t.kind),
  check("supplier_events_one_version", sql`(${t.changeOrderId} IS NULL) <> (${t.revisionId} IS NULL)`),
  check("supplier_events_kind_valid", sql`${t.kind} IN ('order_confirmed', 'credit_confirmed')`),
  check("supplier_events_demo", sql`${t.isDemo}`),
  check("supplier_events_reference", sql`length(btrim(${t.reference})) > 0`),
  check("supplier_events_total", sql`${t.totalCents} >= 0`),
  check(
    "supplier_events_terms",
    sql`(${t.kind} = 'order_confirmed' AND ${t.quantity} >= 1 AND ${t.unitPriceCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.freightCents} >= 0 AND ${t.inStock} IS TRUE AND ${t.totalCents} = ${t.quantity} * ${t.unitPriceCents} + ${t.taxCents} + ${t.freightCents})
      OR (${t.kind} = 'credit_confirmed' AND ${t.quantity} IS NULL AND ${t.unitPriceCents} IS NULL AND ${t.taxCents} IS NULL AND ${t.freightCents} IS NULL AND ${t.inStock} IS NULL)`,
  ),
]);

/**
 * A payment method the client saved in PayPal's vault for this project during a
 * checkout (a PayPal account or a card), so Setti can place later holds without
 * sending the client to PayPal again. At most one is active per project; the
 * client may remove it (see savedPaymentMethodRemovals) and save another later.
 * Never changed or deleted. The token is a server-side secret: it is never
 * logged, kept as call evidence or sent to a browser.
 */
export const savedPaymentMethods = pgTable("saved_payment_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  /** The checkout in which the client agreed to save the payment method. */
  sourceOperationId: uuid("source_operation_id").notNull().unique().references(() => paymentOperations.id),
  /** PayPal's vault payment token. */
  paypalTokenId: text("paypal_token_id").notNull().unique(),
  /** `paypal` for a PayPal account (including Pay Later), `card` for a debit or credit card. */
  kind: text("kind").notNull().default("paypal"),
  /** What the client recognises it by, such as "Visa •••• 0026"; never a full card number or email. */
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("saved_payment_methods_token", sql`length(btrim(${t.paypalTokenId})) > 0`),
  check("saved_payment_methods_kind", sql`${t.kind} in ('paypal', 'card')`),
]);

/**
 * The client removed a saved payment method: PayPal deleted the token first,
 * then this record stops Setti from using it. A record: never changed or deleted.
 */
export const savedPaymentMethodRemovals = pgTable("saved_payment_method_removals", {
  methodId: uuid("method_id").primaryKey().references(() => savedPaymentMethods.id),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  removedAt: timestamp("removed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The studio cancelled an approved furniture item before anything was charged
 * for it: the supplier cannot supply it, never answered, or the client asked in
 * the chat. Its holds are released and no version funds it again. Cancelling
 * gives money back to the client, so it needs a reason but not a signature; a
 * replacement is new money and still goes through a version the client confirms.
 * One per business item. A record: never changed or deleted.
 */
export const itemCancellations = pgTable("item_cancellations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  itemId: uuid("item_id").notNull().unique().references(() => items.id),
  /** The client-confirmed version in force when the item was cancelled: its revision, and its change order unless it was the signed V1. */
  revisionId: uuid("revision_id").notNull().references(() => revisions.id),
  changeOrderId: uuid("change_order_id").references(() => changeOrders.id),
  reason: text("reason").$type<CancellationReason>().notNull(),
  note: text("note").notNull().default(""),
  cancelledBy: text("cancelled_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("item_cancellations_reason", sql`${t.reason} IN ('unavailable', 'no_response', 'client_asked', 'other')`),
  check("item_cancellations_note", sql`length(${t.note}) <= 1000 AND (${t.reason} <> 'other' OR length(btrim(${t.note})) > 0)`),
  check("item_cancellations_by", sql`length(btrim(${t.cancelledBy})) > 0`),
]);

/** What one daily check found for a hold PayPal was asked about. */
export interface HoldReadback {
  paypalAuthorizationId: string;
  outcome: "expired" | "voided" | "still_held" | "captured_elsewhere" | "unreadable";
  paypalStatus: string | null;
  debugId: string | null;
}

/**
 * One run of the daily check: holds past their 29 days read back from PayPal,
 * and renewal notices posted to the chats. `checkedAt` is the clock the run
 * worked against; a demo session's run names its session. Kept as a record.
 */
export const holdChecks = pgTable("hold_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  sessionId: uuid("session_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** Open item holds the run looked at. */
  holds: integer("holds").notNull().default(0),
  readbacks: jsonb("readbacks").$type<HoldReadback[]>().notNull().default([]),
  notices: integer("notices").notNull().default(0),
  /** Holds this run renewed with the client's saved payment method. */
  renewals: integer("renewals").notNull().default(0),
  /** What the run could not check or settle; empty when everything was checked. */
  problems: jsonb("problems").$type<string[]>().notNull().default([]),
}, (t) => [
  check("hold_checks_counts", sql`${t.holds} >= 0 AND ${t.notices} >= 0`),
]);

/**
 * Which holds already had their renewal notice, and in which chat message: a
 * hold is announced once, and one message covers every hold of a project the
 * same run found due. A record: never changed or deleted.
 */
export const renewalNotices = pgTable("renewal_notices", {
  authorizationId: uuid("authorization_id").primaryKey().references(() => paypalAuthorizations.id),
  caseId: uuid("case_id").notNull(),
  messageId: uuid("message_id").notNull(),
  /** The clock of the run that gave the notice; the renewal waits until two days after it. */
  noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How a design-services hold is split across the approved service lines it pays
 * for, written together with the hold's operation. Each line is captured from
 * the hold separately, up to its amount. A record: never changed or deleted.
 */
export const servicesHoldLines = pgTable("services_hold_lines", {
  operationId: uuid("operation_id").notNull().references(() => paymentOperations.id),
  itemId: uuid("item_id").notNull().references(() => items.id),
  amountCents: integer("amount_cents").notNull(),
}, (t) => [
  primaryKey({ columns: [t.operationId, t.itemId] }),
  check("services_hold_lines_amount", sql`${t.amountCents} > 0`),
]);

export type PayPalStep = "create_order" | "get_order" | "authorize_order" | "get_authorization" | "capture" | "get_capture" | "void" | "refund" | "get_refund";

/**
 * Every PayPal call made for an operation, append-only: the receipt evidence
 * (resource id, status, amount, PayPal debug id) without payer details.
 */
export const paypalCalls = pgTable("paypal_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => paymentOperations.id),
  step: text("step").$type<PayPalStep>().notNull(),
  /** PayPal-Request-Id sent with the call; reads have none. */
  requestId: text("request_id"),
  outcome: text("outcome").$type<"ok" | "rejected" | "unknown" | "retryable">().notNull(),
  httpStatus: integer("http_status"),
  debugId: text("debug_id"),
  resourceId: text("resource_id"),
  resourceStatus: text("resource_status"),
  amountCents: integer("amount_cents"),
  currency: text("currency"),
  errorCode: text("error_code"),
  message: text("message"),
  /** Other receipt fields worth keeping, such as the order id or expiration time. */
  details: jsonb("details").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("paypal_calls_outcome_valid", sql`${t.outcome} IN ('ok', 'rejected', 'unknown', 'retryable')`),
  check("paypal_calls_step_valid", sql`${t.step} IN ('create_order', 'get_order', 'authorize_order', 'get_authorization', 'capture', 'get_capture', 'void', 'refund', 'get_refund')`),
]);
