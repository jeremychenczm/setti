/**
 * The PayPal calls the money executor needs, behind an interface so tests can
 * use a fake built from recorded sandbox responses.
 */

export interface CaptureCommand {
  paypalAuthorizationId: string;
  amountCents: number;
  finalCapture: boolean;
  /** Sent as PayPal-Request-Id; the same for every attempt of one operation. */
  requestId: string;
}

export interface CaptureReceipt {
  paypalCaptureId: string;
  status: "completed" | "pending" | "declined";
  amountCents: number;
}

export interface VoidCommand {
  paypalAuthorizationId: string;
  requestId: string;
}

export interface VoidReceipt {
  /** PayPal keeps reporting the original amount after a void, so this is not the amount released. */
  reportedAmountCents?: number;
}

/**
 * How a PayPal call ended:
 * - `rejected`: PayPal refused; sending the same request again gets the same answer.
 * - `unknown`: the request may have been processed; retry with the same request id to find out.
 * - `retryable`: PayPal did not process it; safe to try again later.
 */
export type PayPalResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; code: string; message: string; debugId?: string }
  | { kind: "unknown"; message: string }
  | { kind: "retryable"; message: string };

export interface PayPalPayments {
  captureAuthorization(command: CaptureCommand): Promise<PayPalResult<CaptureReceipt>>;
  /** Releases whatever is still held on the authorization. */
  voidAuthorization(command: VoidCommand): Promise<PayPalResult<VoidReceipt>>;
}

/** Network error codes that mean the request never reached PayPal. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export interface FailureFacts {
  /** HTTP status, when PayPal answered at all. */
  statusCode?: number;
  /** The first `details[].issue` or the error `name` from PayPal's body. */
  code?: string;
  message: string;
  debugId?: string;
  /** Node network error code, when there was no HTTP answer. */
  networkCode?: string;
}

/** Sorts a failed PayPal call into rejected, unknown or retryable. */
export function classifyFailure(facts: FailureFacts): Exclude<PayPalResult<never>, { kind: "ok" }> {
  const { statusCode, message } = facts;
  if (statusCode === undefined) {
    return facts.networkCode && NOT_SENT.has(facts.networkCode) ? { kind: "retryable", message } : { kind: "unknown", message };
  }
  if (statusCode === 429) return { kind: "retryable", message };
  if (statusCode >= 500 || statusCode === 408 || statusCode === 409) return { kind: "unknown", message };
  return { kind: "rejected", code: facts.code ?? `HTTP_${statusCode}`, message, debugId: facts.debugId };
}
