import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items, paymentOperations, projects } from "../db/schema";
import { changeOrders } from "../pricing/schema";

/**
 * What the supplier confirmed, recorded by the designer for one business item
 * of one client-confirmed version. In this demo the designer enters it by hand,
 * so every event is labelled as a demo record. Append-only.
 * - `order_confirmed`: the supplier accepted the order on the confirmed terms; capture may follow.
 * - `credit_confirmed`: the supplier credited a return or cancellation; the refund may follow.
 */
export const supplierEvents = pgTable("supplier_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  changeOrderId: uuid("change_order_id").notNull().references(() => changeOrders.id),
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
