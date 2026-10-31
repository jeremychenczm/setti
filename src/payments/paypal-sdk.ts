/**
 * PayPal adapter on top of the official server SDK. The SDK client is created
 * elsewhere (behind the sandbox guard) and passed in. Receipts copy only what
 * PayPal returned. Payer details are never kept, except a masked label for a
 * payment method the client saves ("Visa •••• 0026", "s•••@example.com").
 */
import {
  ApiError,
  CheckoutPaymentIntent,
  PaymentInitiator,
  PaypalExperienceUserAction,
  PaypalPaymentTokenUsageType,
  PaypalWalletContextShippingPreference,
  StoredPaymentSourcePaymentType,
  StoredPaymentSourceUsageType,
  StoreInVaultInstruction,
  UsagePattern,
  type AuthorizationWithAdditionalData,
  type CapturedPayment,
  type Order,
  type OrderAuthorizeResponse,
  type OrdersController,
  type PaymentAuthorization,
  type PaymentsController,
  type Refund,
  type SellerPayableBreakdown,
  type SellerReceivableBreakdown,
  type VaultController,
} from "@paypal/paypal-server-sdk";
import { classifyFailure, type AuthorizationReceipt, type CallTrace, type CaptureReceipt, type OrderReceipt, type PayPalFailure, type PayPalPayments, type PayPalResult, type RefundReceipt, type ReportedSettlement, type SavedPayPalReceipt, type TestCardApproval } from "./paypal";
import { formatCents, parseCents } from "./receipts";

/** Ask PayPal for the full resource; the default minimal body leaves out the amount. */
const FULL = "return=representation";
const BRAND = "Setti (sandbox demo)";

/** PayPal's documented Sandbox Visa. Probe P10: the Sandbox refused 4111… and 5555… on 2026-10-22. */
export const SANDBOX_TEST_CARD = { number: "4012000033330026", expiry: "2030-12", securityCode: "123", name: "Setti Sandbox Test" } as const;

/**
 * Confirms the app's own order with the test card, so the usual authorize step
 * follows unchanged. Probe P12: the card can also be saved on success, and the
 * authorization then returns its vault token.
 */
export function createSdkTestCardApproval(orders: OrdersController): TestCardApproval {
  return (orderId, options) => call(async () => {
    const card = { ...SANDBOX_TEST_CARD, ...(options?.save ? { attributes: { vault: { storeInVault: StoreInVaultInstruction.OnSuccess } } } : {}) };
    const res = await orders.confirmOrder({ id: orderId, prefer: FULL, body: { paymentSource: { card } } });
    return [orderReceipt(res.result), res];
  });
}

export function createSdkPayPal(controllers: { orders: OrdersController; payments: PaymentsController; vault?: VaultController }): PayPalPayments {
  const { orders, payments, vault } = controllers;
  return {
    createOrder: (command) => call(async () => {
      const res = await orders.createOrder({
        paypalRequestId: command.requestId,
        prefer: FULL,
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [{
            referenceId: command.referenceId,
            amount: { currencyCode: "USD", value: formatCents(command.amountCents) },
            description: command.description.slice(0, 127),
            customId: command.customId,
            invoiceId: command.invoiceId,
          }],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: BRAND,
                returnUrl: command.returnUrl,
                cancelUrl: command.cancelUrl,
                userAction: PaypalExperienceUserAction.PayNow,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              },
              // Probe P11: saving on success works for PayPal and Pay Later buyers alike.
              ...(command.savePayPal ? { attributes: { vault: {
                storeInVault: StoreInVaultInstruction.OnSuccess, usageType: PaypalPaymentTokenUsageType.Merchant,
                usagePattern: UsagePattern.UnscheduledPostpaid, permitMultiplePaymentTokens: true, description: command.savePayPal.description.slice(0, 127),
              } } } : {}),
            },
          },
        },
      });
      return [orderReceipt(res.result), res];
    }),

    createSavedPayPalOrder: (command) => call(async () => {
      const res = await orders.createOrder({
        paypalRequestId: command.requestId,
        prefer: FULL,
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [{
            referenceId: command.referenceId,
            amount: { currencyCode: "USD", value: formatCents(command.amountCents) },
            description: command.description.slice(0, 127),
            customId: command.customId,
            invoiceId: command.invoiceId,
          }],
          // Probe P12: a saved card holds a new amount merchant-initiated, with no buyer step.
          paymentSource: command.kind === "card" ? {
            card: {
              vaultId: command.paypalTokenId,
              storedCredential: { paymentInitiator: PaymentInitiator.Merchant, paymentType: StoredPaymentSourcePaymentType.Unscheduled, usage: StoredPaymentSourceUsageType.Subsequent },
            },
          } : {
            paypal: {
              vaultId: command.paypalTokenId,
              storedCredential: { paymentInitiator: PaymentInitiator.Merchant, usage: StoredPaymentSourceUsageType.Subsequent, usagePattern: UsagePattern.UnscheduledPostpaid },
              ...(command.returnUrl && command.cancelUrl ? { experienceContext: {
                brandName: BRAND, returnUrl: command.returnUrl, cancelUrl: command.cancelUrl,
                userAction: PaypalExperienceUserAction.PayNow, shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
              } } : {}),
            },
          },
        },
      });
      return [orderReceipt(res.result), res];
    }),

    deleteSavedMethod: (tokenId) => call(async () => {
      if (!vault) throw new Error("This PayPal client cannot delete saved payment methods.");
      const res = await vault.deletePaymentToken(tokenId);
      return [{ deleted: true as const }, res];
    }),

    getOrder: (orderId) => call(async () => {
      const res = await orders.getOrder({ id: orderId });
      return [orderReceipt(res.result), res];
    }),

    authorizeOrder: (command) => call(async () => {
      const res = await orders.authorizeOrder({ id: command.orderId, paypalRequestId: command.requestId, prefer: FULL });
      return [orderReceipt(res.result), res];
    }),

    getAuthorization: (id) => call(async () => {
      const res = await payments.getAuthorizedPayment({ authorizationId: id });
      return [authorizationReceipt(res.result), res];
    }),

    captureAuthorization: (command) => call(async () => {
      const res = await payments.captureAuthorizedPayment({
        authorizationId: command.paypalAuthorizationId,
        paypalRequestId: command.requestId,
        prefer: FULL,
        body: { amount: { currencyCode: "USD", value: formatCents(command.amountCents) }, finalCapture: command.finalCapture },
      });
      return [captureReceipt(res.result), res];
    }),

    getCapture: (id) => call(async () => {
      const res = await payments.getCapturedPayment({ captureId: id });
      return [captureReceipt(res.result), res];
    }),

    voidAuthorization: (command) => call(async () => {
      const res = await payments.voidPayment({ authorizationId: command.paypalAuthorizationId, paypalRequestId: command.requestId, prefer: FULL });
      // A minimal (empty) answer still means PayPal accepted the void; the executor reads the hold back.
      return [res.result ? authorizationReceipt(res.result) : {}, res];
    }),

    refundCapture: (command) => call(async () => {
      const res = await payments.refundCapturedPayment({
        captureId: command.paypalCaptureId,
        paypalRequestId: command.requestId,
        prefer: FULL,
        body: { amount: { currencyCode: "USD", value: formatCents(command.amountCents) }, customId: command.customId },
      });
      return [refundReceipt(res.result), res];
    }),

    getRefund: (id) => call(async () => {
      const res = await payments.getRefund({ refundId: id });
      return [refundReceipt(res.result), res];
    }),
  };
}

type Response = { statusCode: number; headers: Record<string, string> };

async function call<T>(send: () => Promise<[T, Response]>): Promise<PayPalResult<T>> {
  try {
    const [value, res] = await send();
    return { kind: "ok", value, trace: trace(res) };
  } catch (error) {
    return fromError(error);
  }
}

function trace(res: Response): CallTrace {
  return { httpStatus: res.statusCode, debugId: header(res.headers, "paypal-debug-id") };
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function money(amount: { currencyCode?: string; value?: string } | undefined) {
  return { amountCents: parseCents(amount?.value), currency: amount?.currencyCode };
}

function authorizationReceipt(auth: PaymentAuthorization | AuthorizationWithAdditionalData, orderId?: string): AuthorizationReceipt {
  const related = "supplementaryData" in auth ? auth.supplementaryData?.relatedIds?.orderId : undefined;
  return {
    paypalAuthorizationId: auth.id, status: auth.status, ...money(auth.amount),
    orderId: related ?? orderId, customId: auth.customId, createTime: auth.createTime, expirationTime: auth.expirationTime,
  };
}

function orderReceipt(order: Order | OrderAuthorizeResponse): OrderReceipt {
  const unit = order.purchaseUnits?.[0];
  const authorization = unit?.payments?.authorizations?.[0];
  const refunds = unit?.payments?.refunds;
  return {
    orderId: order.id, status: order.status, ...money(unit?.amount), customId: unit?.customId,
    approvalUrl: order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href,
    authorization: authorization ? authorizationReceipt(authorization, order.id) : undefined,
    ...(refunds?.length ? { refunds: refunds.map(refundReceipt) } : {}),
    ...savedMethod(order),
  };
}

/** The payment method an order saved, with a masked label; the full card number or email is never kept. */
function savedMethod(order: Order | OrderAuthorizeResponse): { savedPayPal?: SavedPayPalReceipt } {
  const paypal = order.paymentSource?.paypal;
  if (paypal?.attributes?.vault) return { savedPayPal: { status: paypal.attributes.vault.status, tokenId: paypal.attributes.vault.id, kind: "paypal", label: maskEmail(paypal.emailAddress) } };
  const card = order.paymentSource?.card;
  if (card?.attributes?.vault) return { savedPayPal: { status: card.attributes.vault.status, tokenId: card.attributes.vault.id, kind: "card", label: cardLabel(card.brand, card.lastDigits) } };
  return {};
}

function maskEmail(email: string | undefined): string | undefined {
  const [name, domain] = email?.split("@") ?? [];
  return name && domain ? `${name[0]}•••@${domain}` : undefined;
}

function cardLabel(brand: string | undefined, lastDigits: string | undefined): string | undefined {
  if (!lastDigits || !/^\d{2,4}$/.test(lastDigits)) return undefined;
  const name = brand ? brand.toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") : "Card";
  return `${name} •••• ${lastDigits}`;
}

function captureReceipt(capture: CapturedPayment): CaptureReceipt {
  const breakdown = capture.sellerReceivableBreakdown;
  return { paypalCaptureId: capture.id, status: capture.status, ...money(capture.amount), finalCapture: capture.finalCapture, createTime: capture.createTime,
    ...(breakdown ? { settlement: settlement(breakdown) } : {}) };
}

function refundReceipt(refund: Refund): RefundReceipt {
  const breakdown = refund.sellerPayableBreakdown;
  return { paypalRefundId: refund.id, status: refund.status, ...money(refund.amount), createTime: refund.createTime, customId: refund.customId,
    ...(breakdown ? { settlement: settlement(breakdown) } : {}) };
}

function settlement(breakdown: SellerReceivableBreakdown | SellerPayableBreakdown): ReportedSettlement {
  const amounts = [breakdown.grossAmount, breakdown.paypalFee, breakdown.netAmount];
  const settlementMoney = (amount: typeof breakdown.paypalFee) => ({
    amountCents: typeof amount?.value === "string" ? parseCents(amount.value) : undefined,
    currency: typeof amount?.currencyCode === "string" ? amount.currencyCode : undefined,
  });
  return {
    gross: settlementMoney(breakdown.grossAmount), fee: settlementMoney(breakdown.paypalFee), net: settlementMoney(breakdown.netAmount),
    platformFeesPresent: !!breakdown.platformFees?.length,
    conversionPresent: !!breakdown.paypalFeeInReceivableCurrency
      || ("exchangeRate" in breakdown && !!breakdown.exchangeRate)
      || ("receivableAmount" in breakdown && !!breakdown.receivableAmount)
      || ("netAmountInReceivableCurrency" in breakdown && !!breakdown.netAmountInReceivableCurrency)
      || ("netAmountBreakdown" in breakdown && !!breakdown.netAmountBreakdown?.length),
    malformed: amounts.some((amount) => amount !== undefined &&
      (amount === null || typeof amount.currencyCode !== "string" || !amount.currencyCode || typeof amount.value !== "string" || parseCents(amount.value) === undefined)),
  };
}

function fromError(error: unknown): PayPalFailure {
  if (error instanceof ApiError) {
    const body = (error.result ?? {}) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string }[] };
    return classifyFailure({
      statusCode: error.statusCode,
      code: body.details?.[0]?.issue ?? body.name,
      message: body.message ?? error.message,
      debugId: body.debug_id ?? header(error.headers, "paypal-debug-id"),
    });
  }
  const networkCode = (error as { code?: unknown })?.code;
  return classifyFailure({
    message: error instanceof Error ? error.message : String(error),
    networkCode: typeof networkCode === "string" ? networkCode : undefined,
  });
}
