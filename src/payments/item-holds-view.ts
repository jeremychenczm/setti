/**
 * What the item-holds section shows: every approved furniture item of the
 * current agreement, what PayPal holds or captured for it, and whether the
 * project's saved PayPal can hold the rest. Read from recorded facts only.
 */
import { eq } from "drizzle-orm";
import type { DemoAccount } from "../accounts/demo";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, revisionLines } from "../db/schema";
import { PaymentActionError } from "./binding";
import { activeSavedMethod, savedMethodView, type SavedMethodView } from "./saved-methods";
import { lockPaymentBasis } from "./services";
import type { CheckoutView, DemoCheckout } from "./types";

export interface ItemHoldView {
  /** The quote line id. */
  itemId: string;
  label: string;
  targetCents: number;
  heldCents: number;
  capturedCents: number;
  state: "captured" | "confirmed" | "held" | "holding" | "awaiting_client" | "unknown" | "failed" | "to_hold";
  operationId: string | null;
  /** Only the owning project's client receives the provider approval link. */
  approvalUrl: string | null;
  canCheck: boolean;
  canCancel: boolean;
  /** With no saved method, the client may hold this item alone through PayPal or the Sandbox test card (V1 only). */
  canCheckout: boolean;
  paypalAuthorizationId: string | null;
  expiresAt: string | null;
  failureMessage: string | null;
  /** Who supplies the item. */
  vendor: string | null;
  /** The terms the client approved, which the supplier's confirmation must match (V1 lines only). */
  terms: { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; leadTimeDays: number | null } | null;
  /** The supplier's order confirmation recorded for this version (demo, entered by the designer). */
  supplier: { reference: string; totalCents: number; leadTimeDays: number | null } | null;
}

export interface ItemHoldsView {
  projectKey: CaseKey;
  basis: { version: number; orderId: string | null } | null;
  items: ItemHoldView[];
  /** Approved furniture not held or captured yet. */
  toHoldCents: number;
  savedPayPal: boolean;
  /** The project's active saved payment method, as the client recognises it. */
  savedMethod: SavedMethodView | null;
  canRemoveSaved: boolean;
  /** How the client can pay for one item at a time; present only while some item can be held that way. */
  checkoutOptions: CheckoutView | null;
  /** Either account of the project may hold the rest with the client's saved payment method. */
  canHold: boolean;
  /** On V1 the designer records supplier confirmations and captures here; a change order has its own payments panel. */
  canConfirmSupplier: boolean;
  /** The hash of the document the client confirmed, sent back with supplier and capture steps. */
  contentHash: string | null;
  reason: string | null;
}

export async function itemHoldsView(db: Db, sessionId: string | null, key: CaseKey, account: DemoAccount | null, demo: DemoCheckout | null = null): Promise<ItemHoldsView> {
  const empty = (reason: string): ItemHoldsView => ({ projectKey: key, basis: null, items: [], toHoldCents: 0, savedPayPal: false, savedMethod: null, canRemoveSaved: false, checkoutOptions: null, canHold: false, canConfirmSupplier: false, contentHash: null, reason });
  if (!sessionId) return empty("Open this project from the browser that owns the demo case.");
  let basis;
  try { basis = await db.transaction((tx) => lockPaymentBasis(tx, sessionId, key)); }
  catch (error) {
    if (error instanceof PaymentActionError) return empty(error.message);
    throw error;
  }
  const { ledger, plan } = basis;
  // A later successful attempt cannot resolve the older provider order's uncertain money.
  // Keep migration warnings visible even when that item is already fully funded.
  const manualReviews = ledger.operations.filter((operation) => operation.failureCode === "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED"
    && (operation.status === "pending" || operation.status === "unknown"));
  const member = !!account && (account.role === "designer" || account.projectKey === key);
  const client = member && account?.role === "client";
  const projectItems = await db.select({ id: items.id, kind: items.kind, vendor: items.vendor }).from(items).where(eq(items.projectId, basis.projectId));
  const kinds = new Map(projectItems.map((row) => [row.id, row.kind]));
  const vendors = new Map(projectItems.map((row) => [row.id, row.vendor]));
  const saved = savedMethodView(await activeSavedMethod(db, basis.projectId));
  // On V1 the approved terms are the V1 revision's lines; a change order's page shows its own.
  const v1Terms = basis.orderId ? new Map() : new Map((await db.select().from(revisionLines).where(eq(revisionLines.revisionId, basis.key)))
    .map((row) => [row.itemId, { quantity: row.quantity, unitPriceCents: row.unitPriceCents, taxCents: row.taxCents, freightCents: row.freightCents, leadTimeDays: row.leadTimeDays }]));
  const now = Date.now();
  const lines = plan.lines.flatMap((line): ItemHoldView[] => {
    const businessId = basis.businessItem(line);
    const manualReview = manualReviews.find((operation) => operation.itemId === businessId);
    if (!businessId || kinds.get(businessId) !== "furniture" || (line.targetCents === 0 && !manualReview)) return [];
    const latest = ledger.operations.filter((operation) => operation.kind === "authorize" && operation.itemId === businessId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const displayedOperation = manualReview ?? latest;
    const hold = ledger.authorizations.filter((entry) => entry.itemId === businessId && (entry.status === "created" || entry.status === "partially_captured") && !(entry.expiresAt && entry.expiresAt.getTime() <= now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const funded = line.heldCents + line.capturedCents - line.refundedCents;
    const event = ledger.supplierEvents.find((entry) => entry.kind === "order_confirmed" && entry.itemId === businessId && (basis.orderId ? entry.changeOrderId === basis.orderId : entry.revisionId === basis.key));
    const state = manualReview ? "unknown"
      : line.capturedCents - line.refundedCents >= line.targetCents ? "captured"
      : funded >= line.targetCents && event ? "confirmed"
      : funded >= line.targetCents ? "held"
        : latest?.status === "unknown" ? "unknown"
          : latest?.status === "pending" && latest.approvalUrl ? "awaiting_client"
          : latest?.status === "pending" ? "holding"
          : latest?.status === "failed" ? "failed" : "to_hold";
    return [{
      itemId: line.itemId, label: line.label, targetCents: line.targetCents, heldCents: line.heldCents, capturedCents: line.capturedCents - line.refundedCents, state,
      operationId: displayedOperation?.id ?? null,
      approvalUrl: !manualReview && client && state === "awaiting_client" ? displayedOperation?.approvalUrl ?? null : null,
      canCheck: member && !!displayedOperation && ["holding", "awaiting_client", "unknown"].includes(state),
      canCancel: !manualReview && client && state === "awaiting_client",
      canCheckout: false,
      paypalAuthorizationId: hold?.paypalAuthorizationId ?? null, expiresAt: hold?.expiresAt?.toISOString() ?? null,
      failureMessage: ["failed", "awaiting_client", "unknown"].includes(state) ? displayedOperation?.failureMessage ?? null : null,
      vendor: vendors.get(businessId) ?? null,
      terms: v1Terms.get(businessId) ?? null,
      supplier: event ? { reference: event.reference, totalCents: event.totalCents, leadTimeDays: event.leadTimeDays } : null,
    }];
  });
  const toHoldCents = lines.reduce((total, line) => total + Math.max(line.targetCents - line.heldCents - line.capturedCents, 0), 0);
  const waiting = lines.some((line) => ["holding", "awaiting_client", "unknown"].includes(line.state));
  const canHold = member && !!saved && toHoldCents > 0 && !waiting && plan.status !== "blocked" && manualReviews.length === 0;
  // Change orders take each item's payment on their own payments panel; V1 takes it here.
  const oneByOne = client && !saved && !basis.orderId && !waiting && plan.status !== "blocked" && manualReviews.length === 0;
  for (const line of lines) line.canCheckout = oneByOne && (line.state === "to_hold" || line.state === "failed");
  const reason = manualReviews.length ? manualReviews[0].failureMessage ?? "Legacy PayPal orders require manual review before this project can place any further holds."
    : !lines.length ? "The client has not approved a furniture item yet."
    : toHoldCents === 0 ? null
      : !saved ? client ? "Hold each item with PayPal or a card below. Saving the method lets the studio hold the rest without another window."
        : "No payment method is saved. The client holds each item with PayPal or a card, or saves a method for the studio to use."
        : !member ? "Only the project's client or designer can hold items."
          : waiting ? "An item hold is still open. Continue or check that same PayPal order before starting more holds."
            : null;
  const canConfirmSupplier = account?.role === "designer" && !basis.orderId;
  return { projectKey: key, basis: { version: basis.version, orderId: basis.orderId }, items: lines, toHoldCents, savedPayPal: !!saved, savedMethod: saved, canRemoveSaved: client && !!saved,
    checkoutOptions: demo && lines.some((line) => line.canCheckout) ? { ...demo, canSave: true } : null, canHold, canConfirmSupplier, contentHash: basis.contentHash, reason };
}
