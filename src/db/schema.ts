/**
 * Database schema. Money columns are integer cents.
 *
 * Quotes are versioned: every revision is a full snapshot of what the project
 * should contain. Once a revision is sent it is frozen (enforced by triggers in
 * the quote-rules migration), and approvals must carry the frozen content hash.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

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

/** Furniture is held until the vendor confirms; services are charged on approval. */
export const itemKind = pgEnum("item_kind", ["furniture", "service"]);

/** A thing the project may buy. Prices live on revision lines, so they can change per version. */
export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  vendor: text("vendor").notNull(),
  kind: itemKind("kind").notNull().default("furniture"),
  sourceUrl: text("source_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const revisionStatus = pgEnum("revision_status", ["draft", "sent", "approved", "declined", "superseded"]);

/** V1 is the first quote; every later change is a new revision based on the approved one. */
export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    basedOnRevisionId: uuid("based_on_revision_id").references((): AnyPgColumn => revisions.id),
    status: revisionStatus("status").notNull().default("draft"),
    /** SHA-256 of the line snapshot, set when the revision is sent. */
    contentHash: text("content_hash"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("revisions_project_number").on(t.projectId, t.number),
    check("revisions_number_positive", sql`${t.number} >= 1`),
    check("revisions_sent_has_hash", sql`${t.status} = 'draft' OR ${t.contentHash} IS NOT NULL`),
  ],
);

/** One item in one revision, with the price and terms the client sees. */
export const revisionLines = pgTable(
  "revision_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    freightCents: integer("freight_cents").notNull().default(0),
    /** Restocking fee in basis points (2000 = 20%), from the vendor's return terms. */
    restockingFeeBps: integer("restocking_fee_bps"),
    returnable: boolean("returnable").notNull().default(true),
    customMade: boolean("custom_made").notNull().default(false),
    leadTimeDays: integer("lead_time_days"),
  },
  (t) => [
    unique("revision_lines_one_per_item").on(t.revisionId, t.itemId),
    check("revision_lines_quantity_positive", sql`${t.quantity} >= 1`),
    check("revision_lines_amounts_not_negative", sql`${t.unitPriceCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.freightCents} >= 0`),
    check("revision_lines_restocking_range", sql`${t.restockingFeeBps} IS NULL OR ${t.restockingFeeBps} BETWEEN 0 AND 10000`),
  ],
);

export const authorizationStatus = pgEnum("authorization_status", ["created", "partially_captured", "captured", "voided", "expired"]);
export const captureStatus = pgEnum("capture_status", ["completed", "pending", "declined"]);
export const refundStatus = pgEnum("refund_status", ["pending", "completed", "failed"]);

/**
 * A hold PayPal placed on the client's money. Captures may not exceed the
 * amount plus PayPal's allowance (enforced by the money-rules migration).
 */
export const paypalAuthorizations = pgTable(
  "paypal_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    /** The item this hold is for, when each item has its own hold. */
    itemId: uuid("item_id").references(() => items.id),
    paypalOrderId: text("paypal_order_id").notNull(),
    paypalAuthorizationId: text("paypal_authorization_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    status: authorizationStatus("status").notNull().default("created"),
    honorExpiresAt: timestamp("honor_expires_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set on the new authorization PayPal returns after a reauthorization. */
    reauthorizedFromId: uuid("reauthorized_from_id").references((): AnyPgColumn => paypalAuthorizations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("paypal_authorizations_amount_positive", sql`${t.amountCents} > 0`)],
);

/** Money PayPal took: from a hold, or directly (for example a service fee charged on approval). */
export const paypalCaptures = pgTable(
  "paypal_captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    authorizationId: uuid("authorization_id").references(() => paypalAuthorizations.id),
    paypalCaptureId: text("paypal_capture_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    finalCapture: boolean("final_capture").notNull().default(false),
    status: captureStatus("status").notNull().default("completed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("paypal_captures_amount_positive", sql`${t.amountCents} > 0`)],
);

/** Money returned from a capture. Refunds of one capture may not add up to more than it. */
export const paypalRefunds = pgTable(
  "paypal_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    captureId: uuid("capture_id")
      .notNull()
      .references(() => paypalCaptures.id),
    paypalRefundId: text("paypal_refund_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    status: refundStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("paypal_refunds_amount_positive", sql`${t.amountCents} > 0`)],
);

/** Every kind of money move Setti asks PayPal for. Only `capture` is executed so far. */
export const operationKind = pgEnum("operation_kind", ["capture", "void", "refund", "authorize", "reauthorize"]);
/** `unknown` means PayPal may or may not have done it; retry with the same request id to find out. */
export const operationStatus = pgEnum("operation_status", ["pending", "succeeded", "failed", "unknown"]);

/**
 * One money move, written before PayPal is called so a crash or timeout never
 * loses track of it. Every attempt sends the same request id, which PayPal
 * uses to avoid doing the same move twice.
 */
export const paymentOperations = pgTable(
  "payment_operations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    kind: operationKind("kind").notNull(),
    status: operationStatus("status").notNull().default("pending"),
    authorizationId: uuid("authorization_id").references(() => paypalAuthorizations.id),
    amountCents: integer("amount_cents").notNull(),
    finalCapture: boolean("final_capture").notNull().default(false),
    requestId: text("request_id").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    /** The PayPal id of what this move produced, for example the capture id. */
    paypalResourceId: text("paypal_resource_id"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payment_operations_amount_positive", sql`${t.amountCents} > 0`),
    check("payment_operations_capture_has_authorization", sql`${t.kind} <> 'capture' OR ${t.authorizationId} IS NOT NULL`),
  ],
);

export const decision = pgEnum("decision", ["approved", "declined"]);

/** The client's decision on one line of a sent revision, bound to its exact content. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id),
    revisionLineId: uuid("revision_line_id")
      .notNull()
      .references(() => revisionLines.id),
    decision: decision("decision").notNull(),
    approverName: text("approver_name").notNull(),
    /** The name the client typed to sign. */
    signature: text("signature").notNull(),
    /** Must equal the revision's content hash at the time of the decision. */
    contentHash: text("content_hash").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("approvals_one_per_line").on(t.revisionLineId)],
);
