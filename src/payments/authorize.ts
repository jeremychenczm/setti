/**
 * Authorization executor: one operation per business event "hold this item's
 * confirmed amount". It creates a PayPal AUTHORIZE order, waits for the buyer
 * to approve it on PayPal, then authorizes the order and records the hold.
 *
 * Whether the buyer approved is always read from PayPal (the order status),
 * never taken from the browser coming back, and a hold is recorded only from a
 * verified receipt: the operation's order, its custom id, the exact amount in
 * USD and a usable status. A checkout may also save the buyer's PayPal or card
 * for the project's later holds; the token PayPal returns is stored with the hold.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations, projects, savedPaymentMethods } from "../db/schema";
import { HONOR_PERIOD_DAYS } from "../money/authorization";
import { noteInCase } from "./notes";
import { claimOperation, recordCall, recordFailure, updateOperation, type PaymentOperation } from "./operations";
import type { AuthorizationReceipt, OrderReceipt, PayPalPayments, PayPalResult, SavedPayPalReceipt } from "./paypal";
import { formatCents, holdStatus, verifyAuthorization, type VerifiedAuthorization } from "./receipts";
import { activeSavedMethod } from "./saved-methods";

const DAY_MS = 86_400_000;

export interface CheckoutLinks {
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutDetails {
  /** What the buyer sees on PayPal, for example "Willow Residence · BERGMUND Chair · V3". */
  description: string;
  /** What the buyer agrees to when the checkout also saves PayPal for the project. */
  savePayPalDescription?: string;
}

/** Creates the PayPal order for an authorization operation, once; later calls return the same order. */
export async function createCheckout(db: Db, paypal: PayPalPayments, operation: PaymentOperation, links: CheckoutLinks, details: CheckoutDetails): Promise<PaymentOperation> {
  if (operation.kind !== "authorize" || operation.savedMethodId) throw new Error(`Payment operation ${operation.id} is not a checkout`);
  if (operation.savePaymentMethod && !details.savePayPalDescription) throw new Error(`Checkout ${operation.id} saves PayPal but tells the buyer nothing about it`);
  if (operation.paypalOrderId || operation.status === "succeeded" || operation.status === "failed") return operation;
  const result = await paypal.createOrder({
    requestId: `${operation.requestId}-order`, amountCents: operation.amountCents, referenceId: operation.itemId ?? "design-services",
    customId: operation.id, invoiceId: `setti-${operation.id}`, description: details.description, ...links,
    ...(operation.savePaymentMethod ? { savePayPal: { description: details.savePayPalDescription! } } : {}),
  });
  await logOrder(db, operation, "create_order", `${operation.requestId}-order`, result);
  if (result.kind !== "ok") {
    // A second click may have created the same order meanwhile; its result wins over this attempt's error.
    const [latest] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operation.id));
    return latest.paypalOrderId ? latest : recordFailure(db, operation.id, result);
  }
  const order = result.value;
  if (!order.orderId || !order.approvalUrl) {
    return updateUnsettledCheckout(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal created the order without returning its id and approval link.", ...(order.orderId ? { paypalOrderId: order.orderId } : {}) });
  }
  if (order.amountCents !== undefined && (order.amountCents !== operation.amountCents || order.currency !== "USD")) {
    return updateUnsettledCheckout(db, operation.id, { status: "unknown", paypalOrderId: order.orderId, failureCode: "RECEIPT_MISMATCH", failureMessage: `PayPal created the order for ${formatCents(order.amountCents)} ${order.currency}; Setti asked for ${formatCents(operation.amountCents)} USD.` });
  }
  return updateUnsettledCheckout(db, operation.id, { status: "pending", paypalOrderId: order.orderId, approvalUrl: order.approvalUrl, failureCode: null, failureMessage: null });
}

export type CheckoutState = "awaiting_buyer" | "authorized" | "failed" | "unknown" | "cancelled";

function checkoutResult(operation: PaymentOperation, state: CheckoutState): { operation: PaymentOperation; state: CheckoutState } {
  return { operation, state: operation.status === "succeeded" ? "authorized" : operation.status === "failed" ? "failed" : state };
}

/** A delayed checkout read or cancel cannot overwrite an authorization already recorded by another request. */
async function updateUnsettledCheckout(db: Db, id: string, fields: Partial<typeof paymentOperations.$inferInsert>): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, id)).for("update");
    if (current.status === "succeeded" || current.status === "failed" || current.paypalResourceId) return current;
    const update = fields.failureCode === null && current.failureCode === "CHECKOUT_CANCEL_REQUESTED"
      ? { ...fields, failureCode: current.failureCode, failureMessage: current.failureMessage }
      : fields;
    return updateOperation(tx, id, update);
  });
}

function checkoutReceiptError(order: OrderReceipt, operation: PaymentOperation): { code: "RECEIPT_INCOMPLETE" | "RECEIPT_MISMATCH"; message: string } | null {
  if (!order.orderId || order.amountCents === undefined || !order.currency) return { code: "RECEIPT_INCOMPLETE", message: "PayPal did not return the checkout id, amount and currency. Check this checkout again before continuing." };
  if (order.orderId !== operation.paypalOrderId || (order.customId !== undefined && order.customId !== operation.id)) return { code: "RECEIPT_MISMATCH", message: "PayPal returned a checkout for a different Setti operation. Nothing will be authorized until its identity is reconciled." };
  if (order.amountCents !== operation.amountCents || order.currency !== "USD") return { code: "RECEIPT_MISMATCH", message: "The PayPal checkout amount or currency differs from the confirmed amount. Nothing will be authorized until it is reconciled." };
  return null;
}

/** A buyer fallback is only a provider link for this exact Sandbox order and amount. */
export function verifiedApprovalLink(order: OrderReceipt, operation: PaymentOperation): string | null {
  if (!order.approvalUrl || order.orderId !== operation.paypalOrderId || order.amountCents !== operation.amountCents || order.currency !== "USD") return null;
  try {
    const url = new URL(order.approvalUrl);
    return url.protocol === "https:" && ["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(url.hostname)
      && !url.username && !url.password && url.searchParams.get("token") === order.orderId ? url.href : null;
  } catch { return null; }
}

/**
 * Advances an authorization from what PayPal reports now: approved orders are
 * authorized, completed ones are read back, unapproved ones keep waiting.
 */
export async function completeAuthorization(db: Db, paypal: PayPalPayments, operationId: string, allowSaved = false): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  const claim = await claimOperation(db, operationId, "authorize");
  if (claim.finished) return { operation: claim.operation, state: claim.operation.status === "succeeded" ? "authorized" : "failed" };
  const { operation } = claim;
  if (operation.savedMethodId && !allowSaved) throw new Error(`Payment operation ${operation.id} is a saved-PayPal hold, not a checkout`);
  if (!operation.paypalOrderId) return { operation, state: operation.status === "unknown" ? "unknown" : "awaiting_buyer" };

  // A hold PayPal is still reviewing is read back by its id.
  if (operation.paypalResourceId) {
    const read = await paypal.getAuthorization(operation.paypalResourceId);
    await logHold(db, operation, read);
    if (read.kind !== "ok") return { operation: await updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the hold: ${read.message}` }), state: "unknown" };
    // Only the order says whether PayPal was saved.
    if (operation.savePaymentMethod && holdStatus(read.value.status) === "created") {
      const order = await paypal.getOrder(operation.paypalOrderId);
      await logOrder(db, operation, "get_order", null, order);
      return settle(db, operation, read.value, order.kind === "ok" ? order.value.savedPayPal : undefined);
    }
    return settle(db, operation, read.value);
  }

  const found = await paypal.getOrder(operation.paypalOrderId);
  await logOrder(db, operation, "get_order", null, found);
  if (found.kind !== "ok") {
    if (found.kind === "rejected" && found.code === "RESOURCE_NOT_FOUND") return fail(db, operation, "ORDER_EXPIRED", "PayPal no longer has this checkout; nothing was authorized. Start a new authorization.");
    return { operation: await updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the checkout: ${found.message}` }), state: "unknown" };
  }
  const order = found.value;
  const receiptError = checkoutReceiptError(order, operation);
  if (receiptError) return checkoutResult(await updateUnsettledCheckout(db, operation.id, { status: "unknown", failureCode: receiptError.code, failureMessage: receiptError.message }), "unknown");
  switch (order.status) {
    case "CREATED":
    case "PAYER_ACTION_REQUIRED":
    case "SAVED": {
      const approvalUrl = operation.savedMethodId ? verifiedApprovalLink({ ...order, approvalUrl: order.approvalUrl ?? operation.approvalUrl ?? undefined }, operation) : order.approvalUrl;
      if (operation.savedMethodId && !approvalUrl) return checkoutResult(await updateUnsettledCheckout(db, operation.id, {
        status: "unknown", failureCode: "SAVED_PAYPAL_APPROVAL_UNAVAILABLE", failureMessage: "PayPal needs the client, but returned no verified approval link for this order. Check this same hold; no replacement will be started.",
      }), "unknown");
      return checkoutResult(await updateUnsettledCheckout(db, operation.id, {
        status: "pending", ...(!operation.approvalUrl && approvalUrl ? { approvalUrl } : {}),
        failureCode: operation.failureCode === "CHECKOUT_CANCEL_REQUESTED" ? operation.failureCode : operation.savedMethodId ? "SAVED_PAYPAL_NEEDS_CLIENT" : null,
        failureMessage: operation.failureCode === "CHECKOUT_CANCEL_REQUESTED" ? operation.failureMessage : operation.savedMethodId ? "PayPal needs the client to approve this same item hold. Continue on PayPal, then check the result; no new hold is created." : null,
      }), "awaiting_buyer");
    }
    case "VOIDED":
      return fail(db, operation, "ORDER_VOIDED", "PayPal voided this checkout before it was authorized; nothing is held.");
    case "COMPLETED":
      if (order.authorization) return settle(db, operation, order.authorization, order.savedPayPal);
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
  let saved = authorized.value.savedPayPal;
  if (!receipt?.paypalAuthorizationId || receipt.amountCents === undefined || !receipt.status) {
    // A minimal answer: read the order back for its authorization.
    const reread = await paypal.getOrder(operation.paypalOrderId);
    await logOrder(db, operation, "get_order", null, reread);
    receipt = reread.kind === "ok" ? reread.value.authorization ?? receipt : receipt;
    saved = reread.kind === "ok" ? reread.value.savedPayPal ?? saved : saved;
  }
  if (!receipt) return { operation: await updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal authorized the order without returning the authorization." }), state: "unknown" };
  return settle(db, operation, receipt, saved);
}

/**
 * Leaving checkout is not proof that an approval cannot arrive from another
 * window. Keep the same operation open until PayPal reports a terminal result.
 */
export async function cancelCheckout(db: Db, paypal: PayPalPayments, operationId: string, allowSaved = false): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  const [current] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  if (!current || current.kind !== "authorize") throw new Error(`Authorization operation ${operationId} does not exist`);
  if (current.savedMethodId && !allowSaved) throw new Error(`Payment operation ${current.id} is a saved-PayPal hold, not a checkout`);
  if (current.status === "succeeded" || current.status === "failed") return { operation: current, state: current.status === "succeeded" ? "authorized" : "failed" };
  if (current.paypalResourceId) return completeAuthorization(db, paypal, operationId, allowSaved);
  if (!current.paypalOrderId) {
    return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "unknown", failureCode: "CHECKOUT_CANCEL_REQUESTED", failureMessage: "You left checkout while PayPal may still be preparing it. Check this same checkout before starting another authorization." }), "cancelled");
  }
  const found = await paypal.getOrder(current.paypalOrderId);
  await logOrder(db, current, "get_order", null, found);
  if (found.kind === "ok" && (found.value.status === "APPROVED" || found.value.status === "COMPLETED")) return completeAuthorization(db, paypal, operationId, allowSaved);
  if (found.kind === "rejected" && found.code === "RESOURCE_NOT_FOUND") return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "failed", failureCode: "ORDER_EXPIRED", failureMessage: "PayPal no longer has this checkout. Start a new authorization if it is still needed." }), "failed");
  if (found.kind !== "ok") {
    return checkoutResult(await updateUnsettledCheckout(db, current.id, { failureMessage: `PayPal could not confirm that the checkout was not approved: ${found.message}` }), "unknown");
  }
  const receiptError = checkoutReceiptError(found.value, current);
  if (receiptError) return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "unknown", failureCode: receiptError.code, failureMessage: receiptError.message }), "unknown");
  if (found.value.status === "VOIDED") return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "failed", failureCode: "ORDER_VOIDED", failureMessage: "PayPal voided this checkout before it was authorized." }), "failed");
  if (!["CREATED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(found.value.status ?? "")) return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: "PayPal did not report a recognised checkout status. Check the same checkout before starting another authorization." }), "unknown");
  return checkoutResult(await updateUnsettledCheckout(db, current.id, { status: "pending", failureCode: "CHECKOUT_CANCEL_REQUESTED", failureMessage: "You left PayPal. This checkout remains available to continue or check; an approval from another window will still be recorded. Start no replacement while this checkout is open." }), "cancelled");
}

/** Records a verified hold, or explains why it cannot be recorded yet. Holds placed with saved PayPal settle the same way. */
export async function settle(db: Db, operation: PaymentOperation, receipt: AuthorizationReceipt, saved?: SavedPayPalReceipt): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
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
  return { operation: await recordHold(db, operation, hold, saved), state: "authorized" };
}

async function recordHold(db: Db, operation: PaymentOperation, hold: VerifiedAuthorization, saved?: SavedPayPalReceipt): Promise<PaymentOperation> {
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
    }
    const [done] = await tx.update(paymentOperations)
      .set({ status: "succeeded", paypalResourceId: hold.paypalAuthorizationId, failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operation.id)).returning();
    // A project keeps one active saved method; the database accepts one only from this succeeded checkout.
    // Locking the project first lets concurrent checkouts see each other's save.
    let stored: { label: string | null }[] = [];
    if (operation.savePaymentMethod && saved?.status === "VAULTED" && saved.tokenId) {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, operation.projectId)).for("update");
      if (!await activeSavedMethod(tx, operation.projectId)) {
        stored = await tx.insert(savedPaymentMethods).values({
          projectId: operation.projectId, sourceOperationId: operation.id, paypalTokenId: saved.tokenId, kind: saved.kind ?? "paypal", label: saved.label ?? null,
        }).onConflictDoNothing().returning({ label: savedPaymentMethods.label });
      }
    }
    if (!existing) {
      const how = operation.savedMethodId ? " with the client's saved payment method" : "";
      const next = operation.servicesHold ? "Each design service is charged from it next." : "Nothing has been charged; capture waits for the supplier confirmation.";
      const savedNote = stored.length ? ` The client saved ${stored[0].label ?? (saved?.kind === "card" ? "a card" : "PayPal")} for this project's later holds.` : "";
      await noteInCase(tx, operation, ({ version, itemName }) => `PayPal Sandbox authorization recorded${how} for V${version} · ${itemName}: ${formatCents(operation.amountCents)} USD is held (authorization ${hold.paypalAuthorizationId}, order ${operation.paypalOrderId}). ${next}${savedNote}`);
    }
    return done;
  });
}

async function fail(db: Db, operation: PaymentOperation, code: string, message: string): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  return { operation: await updateOperation(db, operation.id, { status: "failed", failureCode: code, failureMessage: message }), state: "failed" };
}

/** Order evidence: whether PayPal saved the buyer's PayPal is kept, the saved token never is. */
export function logOrder(db: Db, operation: PaymentOperation, step: "create_order" | "get_order" | "authorize_order", requestId: string | null, result: PayPalResult<OrderReceipt>) {
  const order = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, step, requestId, result, order && {
    resourceId: order.orderId, status: order.status, amountCents: order.amountCents, currency: order.currency,
    details: { authorizationId: order.authorization?.paypalAuthorizationId, authorizationStatus: order.authorization?.status, expirationTime: order.authorization?.expirationTime, savedPayPal: order.savedPayPal?.status },
  });
}

export function logHold(db: Db, operation: PaymentOperation, result: PayPalResult<AuthorizationReceipt>) {
  const hold = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, "get_authorization", null, result, hold && {
    resourceId: hold.paypalAuthorizationId, status: hold.status, amountCents: hold.amountCents, currency: hold.currency,
    details: { orderId: hold.orderId, expirationTime: hold.expirationTime },
  });
}
