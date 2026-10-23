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
import { changeOrders } from "../pricing/schema";
import { savedPaymentMethods, supplierEvents } from "../payments/schema";

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
    returnable: boolean("returnable").default(true),
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
    currency: text("currency").notNull().default("USD"),
    status: authorizationStatus("status").notNull().default("created"),
    honorExpiresAt: timestamp("honor_expires_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set on the new authorization PayPal returns after a reauthorization. */
    reauthorizedFromId: uuid("reauthorized_from_id").references((): AnyPgColumn => paypalAuthorizations.id),
    /** The client-confirmed version this hold was created for; later versions reuse it for the same business item. */
    changeOrderId: uuid("change_order_id").references((): AnyPgColumn => changeOrders.id),
    /** The authorize operation that produced this hold. */
    operationId: uuid("operation_id").unique().references((): AnyPgColumn => paymentOperations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("paypal_authorizations_amount_positive", sql`${t.amountCents} > 0`),
    check("paypal_authorizations_usd", sql`${t.currency} = 'USD'`),
  ],
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
    currency: text("currency").notNull().default("USD"),
    finalCapture: boolean("final_capture").notNull().default(false),
    status: captureStatus("status").notNull().default("completed"),
    operationId: uuid("operation_id").unique().references((): AnyPgColumn => paymentOperations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("paypal_captures_amount_positive", sql`${t.amountCents} > 0`),
    check("paypal_captures_usd", sql`${t.currency} = 'USD'`),
  ],
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
    currency: text("currency").notNull().default("USD"),
    status: refundStatus("status").notNull().default("pending"),
    operationId: uuid("operation_id").unique().references((): AnyPgColumn => paymentOperations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("paypal_refunds_amount_positive", sql`${t.amountCents} > 0`),
    check("paypal_refunds_usd", sql`${t.currency} = 'USD'`),
  ],
);

/** Every kind of money move Setti asks PayPal for. */
export const operationKind = pgEnum("operation_kind", ["capture", "void", "refund", "authorize", "reauthorize"]);
/**
 * `succeeded` means PayPal returned a verified receipt; the money record keeps its own
 * status (a capture can still be pending). `unknown` means PayPal may or may not have
 * done it: reconcile the same operation, never start a replacement.
 */
export const operationStatus = pgEnum("operation_status", ["pending", "succeeded", "failed", "unknown"]);

/**
 * One money move, written before PayPal is called so a crash or timeout never
 * loses track of it. Every attempt sends the same request id, which PayPal
 * uses to avoid doing the same move twice; the business key makes a repeated
 * click or a second window find the same operation instead of creating another.
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
    /** One business event, for example "authorize this item for this confirmed version". */
    businessKey: text("business_key").notNull().unique(),
    authorizationId: uuid("authorization_id").references(() => paypalAuthorizations.id),
    /** The capture a refund returns money from. */
    captureId: uuid("capture_id").references((): AnyPgColumn => paypalCaptures.id),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    finalCapture: boolean("final_capture").notNull().default(false),
    /**
     * The client-confirmed version this move executes, with both frozen hashes and the business item.
     * A move for a V1 signed line by line has no change order: it names the V1 revision, the hash of
     * the V1 document the client signed and the approved line's item.
     */
    changeOrderId: uuid("change_order_id").references((): AnyPgColumn => changeOrders.id),
    revisionId: uuid("revision_id").references((): AnyPgColumn => revisions.id),
    contentHash: text("content_hash"),
    revisionContentHash: text("revision_content_hash"),
    itemId: uuid("item_id").references((): AnyPgColumn => items.id),
    /** The supplier confirmation a capture relies on, or the supplier credit a refund waits for. */
    supplierEventId: uuid("supplier_event_id").references((): AnyPgColumn => supplierEvents.id),
    /** A checkout that also asks PayPal to save the client's PayPal for this project's later holds. */
    savePaymentMethod: boolean("save_payment_method").notNull().default(false),
    /** A hold placed with the project's saved PayPal: no checkout, no buyer on PayPal. */
    savedMethodId: uuid("saved_method_id").references((): AnyPgColumn => savedPaymentMethods.id),
    requestId: text("request_id").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    /** PayPal order created for an authorization, and the buyer approval link it returned. */
    paypalOrderId: text("paypal_order_id"),
    approvalUrl: text("approval_url"),
    /** The PayPal id of what this move produced, for example the capture id. */
    paypalResourceId: text("paypal_resource_id"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payment_operations_amount_positive", sql`${t.amountCents} > 0`),
    check("payment_operations_usd", sql`${t.currency} = 'USD'`),
    check("payment_operations_hold_moves_have_authorization", sql`${t.kind} NOT IN ('capture', 'void', 'reauthorize') OR ${t.authorizationId} IS NOT NULL`),
    check("payment_operations_refund_has_capture", sql`${t.kind} <> 'refund' OR ${t.captureId} IS NOT NULL`),
    check("payment_operations_authorize_is_bound", sql`${t.kind} <> 'authorize' OR ${t.revisionId} IS NOT NULL`),
    check("payment_operations_save_on_checkout", sql`NOT ${t.savePaymentMethod} OR (${t.kind} = 'authorize' AND ${t.savedMethodId} IS NULL)`),
    check("payment_operations_saved_method_holds", sql`${t.savedMethodId} IS NULL OR (${t.kind} = 'authorize' AND ${t.approvalUrl} IS NULL)`),
    check("payment_operations_capture_after_supplier",sql`${t.kind} <> 'capture' OR ${t.changeOrderId} IS NULL OR ${t.supplierEventId} IS NOT NULL`),
    check(
      "payment_operations_binding_complete",
      sql`(${t.changeOrderId} IS NULL AND ${t.revisionId} IS NULL AND ${t.contentHash} IS NULL AND ${t.revisionContentHash} IS NULL) OR (${t.revisionId} IS NOT NULL AND ${t.contentHash} IS NOT NULL AND ${t.revisionContentHash} IS NOT NULL AND ${t.itemId} IS NOT NULL)`,
    ),
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
    /** The client's reason for declining a line of a V1 signed line by line. */
    note: text("note"),
    /** Decisions the client signed together on a V1 signed line by line. */
    signingId: uuid("signing_id"),
  },
  (t) => [
    unique("approvals_one_per_line").on(t.revisionLineId),
    check("approvals_signed_decline_has_reason", sql`${t.signingId} IS NULL OR ${t.decision} <> 'declined' OR length(btrim(coalesce(${t.note}, ''))) > 0`),
  ],
);

export { chatCases, chatMessages } from "../chat/schema";
export { pricingCases, pricingReviews, changeOrders } from "../pricing/schema";
export { changeOrderDecisions } from "../approval/schema";
export { paypalCalls, savedPaymentMethods, supplierEvents } from "../payments/schema";
export { trySeeds } from "../try/schema";
export { openingQuotes, openingWithdrawals } from "../opening/schema";
