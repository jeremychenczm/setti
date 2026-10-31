/**
 * Hold executor for saved PayPal: one operation per business event "hold this
 * item's confirmed amount with the project's saved PayPal". PayPal normally
 * authorizes the order as it creates it (probe P11). If approval is required,
 * the client continues this same order on PayPal. Every
 * attempt sends the same request id, so a lost answer is recovered by asking
 * again, and the hold is recorded only from a verified receipt, as for a checkout.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, savedPaymentMethods } from "../db/schema";
import { completeAuthorization, logHold, logOrder, settle, verifiedApprovalLink, type CheckoutDetails, type CheckoutLinks } from "./authorize";
import { claimOperation, updateOperation, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { formatCents } from "./receipts";

export async function executeSavedHold(db: Db, paypal: PayPalPayments, operationId: string, details: CheckoutDetails, links?: CheckoutLinks): Promise<PaymentOperation> {
  const [existing] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  // Migration found several possible legacy orders for this item. Only explicit manual reconciliation may resolve them.
  if (existing?.failureCode === "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED") return existing;
  if (existing?.savedMethodId && existing.paypalOrderId && existing.status !== "succeeded" && existing.status !== "failed") return (await completeAuthorization(db, paypal, operationId, true)).operation;
  const claim = await claimOperation(db, operationId, "authorize");
  if (claim.finished) return claim.operation;
  const { operation } = claim;
  if (operation.failureCode === "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED") return operation;
  if (!operation.savedMethodId) throw new Error(`Payment operation ${operation.id} does not use saved PayPal`);

  // An existing order may now be buyer-approved, including an approval whose browser callback was lost.
  // Reuse the checkout reconciler against this exact saved-method order; never create a second order.
  if (operation.paypalOrderId) return (await completeAuthorization(db, paypal, operation.id, true)).operation;

  // A hold PayPal is still reviewing is read back by its id.
  if (operation.paypalResourceId) {
    const read = await paypal.getAuthorization(operation.paypalResourceId);
    await logHold(db, operation, read);
    if (read.kind !== "ok") return updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the hold: ${read.message}` });
    return (await settle(db, operation, read.value)).operation;
  }

  // The post-claim existing-order return above handles a concurrent create before this claim.
  // Only an operation still lacking an order reaches this idempotent create.
  const [method] = await db.select({ paypalTokenId: savedPaymentMethods.paypalTokenId, kind: savedPaymentMethods.kind }).from(savedPaymentMethods).where(eq(savedPaymentMethods.id, operation.savedMethodId));
  const found = await paypal.createSavedPayPalOrder({
    requestId: operation.requestId, paypalTokenId: method.paypalTokenId, kind: method.kind === "card" ? "card" : "paypal", amountCents: operation.amountCents, referenceId: operation.itemId!,
    customId: operation.id, invoiceId: `setti-${operation.id}`, description: details.description, ...links,
  });
  await logOrder(db, operation, "create_order", operation.requestId, found);
  if (found.kind !== "ok") return updateSavedHold(db, operation.id, {
    status: found.kind === "rejected" ? "failed" : found.kind === "retryable" ? "pending" : "unknown",
    failureCode: found.kind === "rejected" ? found.code : null, failureMessage: found.message,
  });

  const order = found.value;
  if (!order.orderId) return unknown(operation, "RECEIPT_INCOMPLETE", "PayPal answered without the order id. Check this hold again; the same request finds the same order.");
  if ((operation.paypalOrderId && order.orderId !== operation.paypalOrderId) || (order.customId !== undefined && order.customId !== operation.id)) {
    return unknown(operation, "RECEIPT_MISMATCH", "PayPal returned an order for a different Setti operation. Nothing is recorded until its identity is reconciled.");
  }
  const current = operation.paypalOrderId ? operation : await updateOperation(db, operation.id, { paypalOrderId: order.orderId });
  if (order.amountCents !== undefined && (order.amountCents !== operation.amountCents || order.currency !== "USD")) {
    return unknown(current, "RECEIPT_MISMATCH", `PayPal created the order for ${formatCents(order.amountCents)} ${order.currency}; Setti asked for ${formatCents(operation.amountCents)} USD.`);
  }
  switch (order.status) {
    case "COMPLETED": {
      let receipt = order.authorization;
      if (!receipt?.paypalAuthorizationId || receipt.amountCents === undefined || !receipt.status) {
        // A minimal answer: read the order back for its authorization.
        const reread = await paypal.getOrder(order.orderId);
        await logOrder(db, current, "get_order", null, reread);
        receipt = reread.kind === "ok" ? reread.value.authorization ?? receipt : receipt;
      }
      if (!receipt) return unknown(current, "RECEIPT_INCOMPLETE", "PayPal completed the order without returning its authorization.");
      return (await settle(db, current, receipt)).operation;
    }
    case "PAYER_ACTION_REQUIRED": {
      const approvalUrl = verifiedApprovalLink(order, current);
      if (!approvalUrl) return unknown(current, "SAVED_PAYPAL_APPROVAL_UNAVAILABLE", "PayPal needs the client, but returned no verified approval link for this order. Check this same hold; no replacement will be started.");
      return updateSavedHold(db, current.id, { status: "pending", approvalUrl, failureCode: "SAVED_PAYPAL_NEEDS_CLIENT", failureMessage: "PayPal needs the client to approve this same item hold. Continue on PayPal, then check the result; no new hold is created." });
    }
    default:
      return unknown(current, "RECEIPT_INCOMPLETE", `PayPal returned an unrecognised order status (${order.status ?? "none"}) for a saved-PayPal hold.`);
  }

  function unknown(target: PaymentOperation, code: string, message: string) {
    return updateSavedHold(db, target.id, { status: "unknown", failureCode: code, failureMessage: message });
  }
}

/** Late payer-action answers cannot overwrite a concurrently recorded authorization. */
async function updateSavedHold(db: Db, id: string, fields: Partial<typeof paymentOperations.$inferInsert>): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, id)).for("update");
    if (current.status === "succeeded" || current.status === "failed" || current.paypalResourceId) return current;
    return updateOperation(tx, id, fields);
  });
}
