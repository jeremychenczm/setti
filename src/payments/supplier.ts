/**
 * Supplier events the designer records for the current client-confirmed
 * version. In this demo the designer enters them by hand, so each one is stored
 * and shown as a demo record. They unlock money steps only when they agree with
 * what the client confirmed: an order confirmation must match the confirmed
 * line exactly before capture, and a credit must equal the confirmed refund
 * before the refund. Any difference sends the change back to pricing and client
 * confirmation instead of moving money on other terms.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { supplierEvents } from "../db/schema";
import { businessItem, confirmedPlan, lockConfirmedVersion, PaymentActionError, type LineRef, type ShownVersion, type Tx } from "./binding";
import { noteInCase } from "./notes";
import { formatCents } from "./receipts";
import { confirmedSupplierTerms } from "./supplier-terms";

export type SupplierEvent = typeof supplierEvents.$inferSelect;

export interface SupplierOrderInput {
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
  freightCents: number;
  inStock: boolean;
  leadTimeDays: number | null;
  reference: string;
  note: string;
}

export interface SupplierCreditInput {
  creditCents: number;
  reference: string;
  note: string;
}

const money = (cents: number) => `$${formatCents(cents)}`;

function text(value: string, name: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max) throw new PaymentActionError("INVALID_INPUT", `${name} is too long.`);
  return trimmed;
}

function cents(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PaymentActionError("INVALID_INPUT", `${name} must be a non-negative amount in cents.`);
  return value;
}

async function existing(tx: Tx, orderId: string, itemId: string, kind: SupplierEvent["kind"]): Promise<SupplierEvent | undefined> {
  const [event] = await tx.select().from(supplierEvents).where(and(eq(supplierEvents.changeOrderId, orderId), eq(supplierEvents.itemId, itemId), eq(supplierEvents.kind, kind)));
  return event;
}

/** The designer records the supplier's order confirmation (demo). Capture becomes available only when it matches. */
export async function recordSupplierOrder(db: Db, sessionId: string, orderId: string, input: LineRef & ShownVersion & SupplierOrderInput): Promise<SupplierEvent> {
  return db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const reference = text(input.reference, "The supplier reference", 200), note = text(input.note, "The note", 1_000);
    if (!reference) throw new PaymentActionError("INVALID_INPUT", "Enter the supplier's confirmation reference.");
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new PaymentActionError("INVALID_INPUT", "The confirmed quantity must be a whole number of at least 1.");
    const terms = { quantity: input.quantity, unitPriceCents: cents(input.unitPriceCents, "The unit price"), taxCents: cents(input.taxCents, "The tax"), freightCents: cents(input.freightCents, "The delivery") };
    if (input.leadTimeDays !== null && (!Number.isSafeInteger(input.leadTimeDays) || input.leadTimeDays < 0 || input.leadTimeDays > 3_650)) throw new PaymentActionError("INVALID_INPUT", "The lead time must be between 0 and 3650 days.");
    const recorded = await existing(tx, version.order.id, itemId, "order_confirmed");
    if (recorded) {
      const same = recorded.quantity === terms.quantity && recorded.unitPriceCents === terms.unitPriceCents && recorded.taxCents === terms.taxCents && recorded.freightCents === terms.freightCents && recorded.reference === reference;
      if (!same) throw new PaymentActionError("IDEMPOTENCY_CONFLICT", "A supplier confirmation with different details is already recorded for this version.");
      return recorded;
    }
    const { plan } = await confirmedPlan(tx, version);
    if (plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before recording the supplier confirmation.", plan.blockers);
    if (!plan.actions.some((action) => action.kind === "capture" && action.timing === "after_vendor_confirmation" && action.itemId === input.itemId && action.side === input.side)) {
      throw new PaymentActionError("NOT_AVAILABLE", "No authorized amount on this line is waiting for a supplier confirmation.");
    }
    const line = confirmedSupplierTerms(version.order, input);
    if (!line) throw new PaymentActionError("NOT_AVAILABLE", "This line has no supplier terms in the confirmed quote.");
    if (!input.inStock) throw new PaymentActionError("INVALID_INPUT", line.purpose === "retained_cost"
      ? "Record the confirmation only once the supplier confirms the retained cost."
      : "Record the confirmation only once the supplier confirms the item is available.");
    const differences = [
      terms.quantity !== line.quantity && `quantity ${terms.quantity} instead of ${line.quantity}`,
      terms.unitPriceCents !== line.unitPriceCents && `unit price ${money(terms.unitPriceCents)} instead of ${money(line.unitPriceCents)}`,
      terms.taxCents !== line.taxCents && `tax ${money(terms.taxCents)} instead of ${money(line.taxCents)}`,
      terms.freightCents !== line.freightCents && `delivery ${money(terms.freightCents)} instead of ${money(line.freightCents)}`,
    ].filter((entry): entry is string => !!entry);
    if (differences.length) {
      throw new PaymentActionError("SUPPLIER_TERMS_CHANGED", `The supplier's terms differ from what the client confirmed in V${version.order.version}, so nothing will be captured. Re-price the change and send the client a new version.`, differences);
    }
    const totalCents = terms.quantity * terms.unitPriceCents + terms.taxCents + terms.freightCents;
    const [event] = await tx.insert(supplierEvents).values({
      projectId: version.projectId, changeOrderId: version.order.id, itemId, kind: "order_confirmed", ...terms,
      inStock: true, leadTimeDays: input.leadTimeDays, totalCents, reference, note, sessionId,
    }).returning();
    await noteInCase(tx, { changeOrderId: version.order.id, itemId }, ({ version: number, itemName }) => line.purpose === "retained_cost"
      ? `Demo supplier retained-cost confirmation recorded by the designer for V${number} · ${itemName}: ${money(totalCents)} total (reference ${reference}). Only the client-confirmed retained cost can be captured; closing the authorization releases its unused balance.`
      : `Demo supplier confirmation recorded by the designer for V${number} · ${itemName}: ${terms.quantity} × ${money(terms.unitPriceCents)} + tax ${money(terms.taxCents)} + delivery ${money(terms.freightCents)} = ${money(totalCents)}, in stock (reference ${reference}). The authorized amount can now be captured.`);
    return event;
  });
}

/** The designer records the supplier's credit for a return or cancellation (demo). The refund becomes available only when it matches. */
export async function recordSupplierCredit(db: Db, sessionId: string, orderId: string, input: LineRef & ShownVersion & SupplierCreditInput): Promise<SupplierEvent> {
  return db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const reference = text(input.reference, "The credit reference", 200), note = text(input.note, "The note", 1_000);
    if (!reference) throw new PaymentActionError("INVALID_INPUT", "Enter the supplier's credit reference.");
    const credit = cents(input.creditCents, "The credit");
    const recorded = await existing(tx, version.order.id, itemId, "credit_confirmed");
    if (recorded) {
      if (recorded.totalCents !== credit || recorded.reference !== reference) throw new PaymentActionError("IDEMPOTENCY_CONFLICT", "A supplier credit with different details is already recorded for this version.");
      return recorded;
    }
    const { plan } = await confirmedPlan(tx, version);
    if (plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before recording the supplier credit.", plan.blockers);
    const refund = plan.actions.find((action) => action.kind === "refund" && action.timing === "after_vendor_credit" && action.itemId === input.itemId && action.side === input.side);
    if (!refund) throw new PaymentActionError("NOT_AVAILABLE", "No refund on this line is waiting for a supplier credit.");
    if (credit !== refund.amountCents) {
      throw new PaymentActionError("SUPPLIER_TERMS_CHANGED", `The supplier credited ${money(credit)}, but V${version.order.version} confirms a refund of ${money(refund.amountCents)} after the retained cost. Nothing will be refunded on other terms: re-price the return and send the client a new version.`);
    }
    const [event] = await tx.insert(supplierEvents).values({ projectId: version.projectId, changeOrderId: version.order.id, itemId, kind: "credit_confirmed", totalCents: credit, reference, note, sessionId }).returning();
    await noteInCase(tx, { changeOrderId: version.order.id, itemId }, ({ version: number, itemName }) => `Demo supplier credit recorded by the designer for V${number} · ${itemName}: ${money(credit)} (reference ${reference}). The confirmed refund can now be sent through PayPal.`);
    return event;
  });
}
