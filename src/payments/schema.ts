import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { paymentOperations } from "../db/schema";

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
