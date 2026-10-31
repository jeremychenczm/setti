/**
 * Demo only: the client pays a checkout with PayPal's documented Sandbox test
 * card instead of logging in to PayPal. The server confirms the operation's own
 * PayPal order with the card (saving it when the checkout asked to), then the
 * usual executor authorizes the order and records the hold from PayPal's
 * receipt. Nothing here decides that money moved.
 */
import type { Db } from "../db/client";
import { completeAuthorization, type CheckoutState } from "./authorize";
import { PaymentActionError } from "./binding";
import type { PaymentOperation } from "./operations";
import type { PayPalPayments, TestCardApproval } from "./paypal";

const APPROVED = ["APPROVED", "COMPLETED"];

export async function approveCheckoutWithTestCard(db: Db, paypal: PayPalPayments, testCard: TestCardApproval, operation: PaymentOperation): Promise<{ operation: PaymentOperation; state: CheckoutState }> {
  if (operation.kind !== "authorize" || operation.savedMethodId) throw new Error(`Payment operation ${operation.id} is not a checkout`);
  if (operation.status === "succeeded" || operation.status === "failed") return completeAuthorization(db, paypal, operation.id);
  if (!operation.paypalOrderId) throw new PaymentActionError("NOT_AVAILABLE", "PayPal has not created this checkout yet. Check it again before paying.");
  // An order the client already approved on PayPal is authorized as it is, not confirmed again.
  const found = await paypal.getOrder(operation.paypalOrderId);
  if (found.kind === "ok" && !APPROVED.includes(found.value.status ?? "")) {
    const approved = await testCard(operation.paypalOrderId, { save: operation.savePaymentMethod });
    if (approved.kind === "rejected") throw new PaymentActionError("OPERATION_REFUSED", `PayPal refused the Sandbox test card (${approved.code}). Nothing was held; try PayPal instead.`);
  }
  return completeAuthorization(db, paypal, operation.id);
}
