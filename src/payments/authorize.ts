/**
 * Authorization executor: one operation per business event "hold this item's
 * confirmed amount". It creates a PayPal AUTHORIZE order, waits for the buyer
 * to approve it on PayPal, then authorizes the order and records the hold.
 *
 * Whether the buyer approved is always read from PayPal (the order status),
 * never taken from the browser coming back, and a hold is recorded only from a
 * verified receipt: the operation's order, its custom id, the exact amount in
 * USD and a usable status.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages } from "../chat/schema";
import { changeOrders } from "../pricing/schema";
import { items, paymentOperations, paypalAuthorizations } from "../db/schema";
import { HONOR_PERIOD_DAYS } from "../money/authorization";
import { claimOperation, recordCall, recordFailure, updateOperation, type PaymentOperation } from "./operations";
import type { AuthorizationReceipt, OrderReceipt, PayPalPayments, PayPalResult } from "./paypal";
import { formatCents, verifyAuthorization, type VerifiedAuthorization } from "./receipts";

const DAY_MS = 86_400_000;

export interface CheckoutLinks {
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutDetails {
  /** What the buyer sees on PayPal, for example "Willow Residence · BERGMUND Chair · V3". */
  description: string;
}

/** Creates the PayPal order for an authorization operation, once; later calls return the same order. */
export async function createCheckout(db: Db, paypal: PayPalPayments, operation: PaymentOperation, links: CheckoutLinks, details: CheckoutDetails): Promise<PaymentOperation> {
  if (operation.kind !== "authorize") throw new Error(`Payment operation ${operation.id} is not an authorization`);
  if (operation.paypalOrderId || operation.status === "succeeded" || operation.status === "failed") return operation;
  const result = await paypal.createOrder({
    requestId: `${operation.requestId}-order`, amountCents: operation.amountCents, referenceId: operation.itemId!,
    customId: operation.id, invoiceId: `setti-${operation.id}`, description: details.description, ...links,
  });
  await logOrder(db, operation, "create_order", `${operation.requestId}-order`, result);
  if (result.kind !== "ok") {
    // A second click may have created the same order meanwhile; its result wins over this attempt's error.
    const [latest] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    return latest.paypalOrderId ? latest : recordFailure(db, operation.id, result);
  }
  const order = result.value;
  if (!order.orderId || !order.approvalUrl) {
    return updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal created the order without returning its id and approval link.", ...(order.orderId ? { paypalOrderId: order.orderId } : {}) });
  }
  if (order.amountCents !== undefined && (order.amountCents !== operation.amountCents || order.currency !== "USD")) {
    return updateOperation(db, operation.id, { status: "unknown", paypalOrderId: order.orderId, failureCode: "RECEIPT_MISMATCH", failureMessage: `PayPal created the order for ${formatCents(order.amountCents)} ${order.currency}; Setti asked for ${formatCents(operation.amountCents)} USD.` });
  }
  return updateOperation(db, operation.id, { status: "pending", paypalOrderId: order.orderId, approvalUrl: order.approvalUrl, failureCode: null, failureMessage: null });
}

export type CheckoutState = "awaiting_buyer" | "authorized" | "failed" | "unknown";

/**
 * Advances an authorization from what PayPal reports now: approved orders are
 * authorized, completed ones are read back, unapproved ones keep waiting.
 */
export async function completeAuthorization(db: Db, paypal: PayPalPayments, operationId: string): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  const claim = await claimOperation(db, operationId, "authorize");
  if (claim.finished) return { operation: claim.operation, state: claim.operation.status === "succeeded" ? "authorized" : "failed" };
  const { operation } = claim;
  if (!operation.paypalOrderId) return { operation, state: operation.status === "unknown" ? "unknown" : "awaiting_buyer" };

  // A hold PayPal is still reviewing is read back by its id.
  if (operation.paypalResourceId) {
    const read = await paypal.getAuthorization(operation.paypalResourceId);
    await logHold(db, operation, read);
    if (read.kind !== "ok") return { operation: await updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the hold: ${read.message}` }), state: "unknown" };
    return settle(db, operation, read.value);
  }

  const found = await paypal.getOrder(operation.paypalOrderId);
  await logOrder(db, operation, "get_order", null, found);
  if (found.kind !== "ok") {
    if (found.kind === "rejected" && found.code === "RESOURCE_NOT_FOUND") return fail(db, operation, "ORDER_EXPIRED", "PayPal no longer has this checkout; nothing was authorized. Start a new authorization.");
    return { operation: await updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the checkout: ${found.message}` }), state: "unknown" };
  }
  const order = found.value;
  switch (order.status) {
    case "CREATED":
    case "PAYER_ACTION_REQUIRED":
    case "SAVED":
      return { operation: await updateOperation(db, operation.id, { status: "pending", failureMessage: null }), state: "awaiting_buyer" };
    case "VOIDED":
      return fail(db, operation, "ORDER_VOIDED", "PayPal voided this checkout before it was authorized; nothing is held.");
    case "COMPLETED":
      if (order.authorization) return settle(db, operation, order.authorization);
      return { operation: await updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal reports the checkout completed but returned no authorization." }), state: "unknown" };
    case "APPROVED":
      break;
    default:
      return { operation: await updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: `PayPal returned an unrecognised checkout status (${order.status ?? "none"}).` }), state: "unknown" };
  }

  const authorized = await paypal.authorizeOrder({ orderId: operation.paypalOrderId, requestId: operation.requestId });
  await logOrder(db, operation, "authorize_order", operation.requestId, authorized);
  if (authorized.kind !== "ok") {
    if (authorized.kind === "rejected") return { operation: await recordFailure(db, operation.id, authorized), state: "failed" };
    return { operation: await recordFailure(db, operation.id, authorized), state: authorized.kind === "retryable" ? "awaiting_buyer" : "unknown" };
  }
  let receipt = authorized.value.authorization;
  if (!receipt?.paypalAuthorizationId || receipt.amountCents === undefined || !receipt.status) {
    // A minimal answer: read the order back for its authorization.
    const reread = await paypal.getOrder(operation.paypalOrderId);
    await logOrder(db, operation, "get_order", null, reread);
    receipt = reread.kind === "ok" ? reread.value.authorization ?? receipt : receipt;
  }
  if (!receipt) return { operation: await updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal authorized the order without returning the authorization." }), state: "unknown" };
  return settle(db, operation, receipt);
}

/**
 * The buyer left PayPal without approving (or the studio abandons the checkout).
 * PayPal is asked first: an approved order is authorized instead of dropped.
 */
export async function cancelCheckout(db: Db, paypal: PayPalPayments, operationId: string): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  const [current] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  if (!current || current.kind !== "authorize") throw new Error(`Authorization operation ${operationId} does not exist`);
  if (current.status === "succeeded" || current.status === "failed") return { operation: current, state: current.status === "succeeded" ? "authorized" : "failed" };
  if (!current.paypalOrderId) {
    // No order was confirmed created, so no buyer could have approved anything.
    return fail(db, current, "CHECKOUT_ABANDONED", "The checkout was abandoned before PayPal returned an order; nothing was authorized.");
  }
  const found = await paypal.getOrder(current.paypalOrderId);
  await logOrder(db, current, "get_order", null, found);
  if (found.kind === "ok" && (found.value.status === "APPROVED" || found.value.status === "COMPLETED")) return completeAuthorization(db, paypal, operationId);
  if (found.kind !== "ok" && !(found.kind === "rejected" && found.code === "RESOURCE_NOT_FOUND")) {
    return { operation: await updateOperation(db, current.id, { failureMessage: `PayPal could not confirm that the checkout was not approved: ${found.message}` }), state: "unknown" };
  }
  return fail(db, current, "BUYER_CANCELLED", "The client left PayPal without approving; no authorization was created.");
}

async function settle(db: Db, operation: PaymentOperation, receipt: AuthorizationReceipt): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  const verified = verifyAuthorization(receipt, { amountCents: operation.amountCents, orderId: operation.paypalOrderId!, customId: operation.id });
  if (!verified.ok) {
    return {
      operation: await updateOperation(db, operation.id, { status: "unknown", failureCode: verified.code, failureMessage: verified.message, ...(receipt.paypalAuthorizationId ? { paypalResourceId: receipt.paypalAuthorizationId } : {}) }),
      state: "unknown",
    };
  }
  const hold = verified.value;
  if (hold.status === "pending") {
    return { operation: await updateOperation(db, operation.id, { status: "pending", paypalResourceId: hold.paypalAuthorizationId, failureCode: "AUTHORIZATION_PENDING", failureMessage: "PayPal is reviewing this authorization; nothing is held until it is created." }), state: "awaiting_buyer" };
  }
  if (hold.status === "denied") {
    return { operation: await updateOperation(db, operation.id, { status: "failed", paypalResourceId: hold.paypalAuthorizationId, failureCode: "AUTHORIZATION_DENIED", failureMessage: "PayPal denied this authorization; nothing is held." }), state: "failed" };
  }
  if (hold.status !== "created") {
    return { operation: await updateOperation(db, operation.id, { status: "unknown", paypalResourceId: hold.paypalAuthorizationId, failureCode: "RECEIPT_MISMATCH", failureMessage: `A new authorization should be CREATED; PayPal reports ${receipt.status}.` }), state: "unknown" };
  }
  return { operation: await recordHold(db, operation, hold), state: "authorized" };
}

async function recordHold(db: Db, operation: PaymentOperation, hold: VerifiedAuthorization): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id)).for("update");
    if (locked.status === "succeeded") return locked;
    const [existing] = await tx.select({ id: paypalAuthorizations.id }).from(paypalAuthorizations).where(eq(paypalAuthorizations.paypalAuthorizationId, hold.paypalAuthorizationId));
    if (!existing) {
      await tx.insert(paypalAuthorizations).values({
        projectId: operation.projectId, itemId: operation.itemId, paypalOrderId: operation.paypalOrderId!, paypalAuthorizationId: hold.paypalAuthorizationId,
        amountCents: operation.amountCents, currency: operation.currency, status: "created",
        honorExpiresAt: hold.createdAt ? new Date(hold.createdAt.getTime() + HONOR_PERIOD_DAYS * DAY_MS) : null, expiresAt: hold.expiresAt,
        changeOrderId: operation.changeOrderId, operationId: operation.id,
      });
      const [order] = await tx.select({ caseId: changeOrders.caseId, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId!));
      const [item] = await tx.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId!));
      await tx.insert(chatMessages).values({
        caseId: order.caseId, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed",
        text: `PayPal Sandbox authorization recorded for V${order.document.version} · ${item.name}: ${formatCents(operation.amountCents)} USD is held (authorization ${hold.paypalAuthorizationId}, order ${operation.paypalOrderId}). Nothing has been charged; capture waits for the supplier confirmation.`,
      });
    }
    const [done] = await tx.update(paymentOperations)
      .set({ status: "succeeded", paypalResourceId: hold.paypalAuthorizationId, failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operation.id)).returning();
    return done;
  });
}

async function fail(db: Db, operation: PaymentOperation, code: string, message: string): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  return { operation: await updateOperation(db, operation.id, { status: "failed", failureCode: code, failureMessage: message }), state: "failed" };
}

function logOrder(db: Db, operation: PaymentOperation, step: "create_order" | "get_order" | "authorize_order", requestId: string | null, result: PayPalResult<OrderReceipt>) {
  const order = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, step, requestId, result, order && {
    resourceId: order.orderId, status: order.status, amountCents: order.amountCents, currency: order.currency,
    details: { authorizationId: order.authorization?.paypalAuthorizationId, authorizationStatus: order.authorization?.status, expirationTime: order.authorization?.expirationTime },
  });
}

function logHold(db: Db, operation: PaymentOperation, result: PayPalResult<AuthorizationReceipt>) {
  const hold = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, "get_authorization", null, result, hold && {
    resourceId: hold.paypalAuthorizationId, status: hold.status, amountCents: hold.amountCents, currency: hold.currency,
    details: { orderId: hold.orderId, expirationTime: hold.expirationTime },
  });
}
