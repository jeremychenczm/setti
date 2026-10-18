/**
 * PayPal adapter on top of the official server SDK. The SDK client is created
 * elsewhere (behind the sandbox guard) and passed in.
 */
import { ApiError, CaptureStatus, type CapturedPayment, type PaymentsController } from "@paypal/paypal-server-sdk";
import { classifyFailure, type CaptureReceipt, type PayPalPayments, type PayPalResult } from "./paypal";

/** Ask PayPal for the full resource; the default minimal body leaves out the amount. */
const FULL = "return=representation";

export function createSdkPayPal(payments: PaymentsController): PayPalPayments {
  return {
    async captureAuthorization(command) {
      try {
        const res = await payments.captureAuthorizedPayment({
          authorizationId: command.paypalAuthorizationId,
          paypalRequestId: command.requestId,
          prefer: FULL,
          body: {
            amount: { currencyCode: "USD", value: (command.amountCents / 100).toFixed(2) },
            finalCapture: command.finalCapture,
          },
        });
        return { kind: "ok", value: toReceipt(res.result, command.amountCents) };
      } catch (error) {
        return fromError(error);
      }
    },
  };
}

function toReceipt(capture: CapturedPayment, requestedCents: number): CaptureReceipt {
  if (!capture.id) throw new Error("PayPal returned a capture without an id");
  const value = capture.amount?.value;
  return {
    paypalCaptureId: capture.id,
    status: captureStatus(capture.status),
    amountCents: value === undefined ? requestedCents : Math.round(Number(value) * 100),
  };
}

function captureStatus(status: CaptureStatus | undefined): CaptureReceipt["status"] {
  switch (status) {
    case CaptureStatus.Pending:
      return "pending";
    case CaptureStatus.Declined:
    case CaptureStatus.Failed:
      return "declined";
    default:
      // COMPLETED, and captures that were later (partially) refunded, still took the money.
      return "completed";
  }
}

function fromError(error: unknown): Exclude<PayPalResult<never>, { kind: "ok" }> {
  if (error instanceof ApiError) {
    const body = (error.result ?? {}) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string }[] };
    return classifyFailure({
      statusCode: error.statusCode,
      code: body.details?.[0]?.issue ?? body.name,
      message: body.message ?? error.message,
      debugId: body.debug_id,
    });
  }
  const networkCode = (error as { code?: unknown })?.code;
  return classifyFailure({
    message: error instanceof Error ? error.message : String(error),
    networkCode: typeof networkCode === "string" ? networkCode : undefined,
  });
}
