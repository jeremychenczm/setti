/**
 * Hold executor for saved PayPal: one operation per business event "hold this
 * item's confirmed amount with the project's saved PayPal". Nobody is sent to
 * PayPal; PayPal authorizes the order as it creates it (probe P11). Every
 * attempt sends the same request id, so a lost answer is recovered by asking
 * again, and the hold is recorded only from a verified receipt, as for a checkout.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { savedPaymentMethods } from "../db/schema";
import { logHold, logOrder, settle, type CheckoutDetails } from "./authorize";
import { claimOperation, recordFailure, updateOperation, type PaymentOperation } from "./operations";
import type { OrderReceipt, PayPalPayments, PayPalResult } from "./paypal";
import { formatCents } from "./receipts";

export async function executeSavedHold(db: Db, paypal: PayPalPayments, operationId: string, details: CheckoutDetails): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "authorize");
  if (claim.finished) return claim.operation;
  const { operation } = claim;
  if (!operation.savedMethodId) throw new Error(`Payment operation ${operation.id} does not use saved PayPal`);

  // A hold PayPal is still reviewing is read back by its id.
  if (operation.paypalResourceId) {
    const read = await paypal.getAuthorization(operation.paypalResourceId);
    await logHold(db, operation, read);
    if (read.kind !== "ok") return updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the hold: ${read.message}` });
    return (await settle(db, operation, read.value)).operation;
  }

  let found: PayPalResult<OrderReceipt>;
  if (operation.paypalOrderId) {
    found = await paypal.getOrder(operation.paypalOrderId);
    await logOrder(db, operation, "get_order", null, found);
    if (found.kind !== "ok") return updateOperation(db, operation.id, { failureMessage: `PayPal could not be reached to check the hold: ${found.message}` });
  } else {
    const [method] = await db.select({ paypalTokenId: savedPaymentMethods.paypalTokenId }).from(savedPaymentMethods).where(eq(savedPaymentMethods.id, operation.savedMethodId));
    found = await paypal.createSavedPayPalOrder({
      requestId: operation.requestId, paypalTokenId: method.paypalTokenId, amountCents: operation.amountCents, referenceId: operation.itemId!,
      customId: operation.id, invoiceId: `setti-${operation.id}`, description: details.description,
    });
    await logOrder(db, operation, "create_order", operation.requestId, found);
    if (found.kind !== "ok") return recordFailure(db, operation.id, found);
  }

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
    case "PAYER_ACTION_REQUIRED":
      return updateOperation(db, current.id, { status: "failed", failureCode: "SAVED_PAYPAL_NEEDS_CLIENT", failureMessage: "PayPal wants the client to approve this hold, so saved PayPal could not place it. Nothing is held." });
    default:
      return unknown(current, "RECEIPT_INCOMPLETE", `PayPal returned an unrecognised order status (${order.status ?? "none"}) for a saved-PayPal hold.`);
  }

  function unknown(target: PaymentOperation, code: string, message: string) {
    return updateOperation(db, target.id, { status: "unknown", failureCode: code, failureMessage: message });
  }
}
