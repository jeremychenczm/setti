/**
 * The PayPal calls the money executors need, behind an interface so tests can
 * use a fake built from recorded sandbox responses.
 *
 * Receipts carry exactly what PayPal returned: a missing status, amount or
 * currency stays missing and statuses keep PayPal's own words. The executors
 * decide what an incomplete receipt means (see receipts.ts); nothing here turns
 * "PayPal did not say" into "completed".
 */

/** The amount PayPal reported, in exact cents, and its currency code. */
export interface ReportedMoney {
  amountCents?: number;
  currency?: string;
}

/** Provider-reported seller amounts; missing fields never imply zero. */
export interface ReportedSettlement {
  gross: ReportedMoney;
  /** PayPal's fee component, not an additional customer charge. */
  fee: ReportedMoney;
  /** Capture: seller receipt. Refund: seller debit for that refund. */
  net: ReportedMoney;
  platformFeesPresent: boolean;
  conversionPresent: boolean;
  /** A supplied monetary field could not be read as an exact non-negative amount. */
  malformed?: boolean;
}

export interface CreateOrderCommand {
  /** Sent as PayPal-Request-Id; the same for every attempt to create this operation's order. */
  requestId: string;
  amountCents: number;
  /** Purchase unit reference: the business item the hold is for. */
  referenceId: string;
  /** Setti operation id; PayPal echoes it on the order and its authorization. */
  customId: string;
  invoiceId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface AuthorizeOrderCommand {
  orderId: string;
  requestId: string;
}

export interface AuthorizationReceipt extends ReportedMoney {
  paypalAuthorizationId?: string;
  /** CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED or PENDING. */
  status?: string;
  orderId?: string;
  customId?: string;
  createTime?: string;
  expirationTime?: string;
}

export interface OrderReceipt extends ReportedMoney {
  orderId?: string;
  /** CREATED, SAVED, APPROVED, VOIDED, COMPLETED or PAYER_ACTION_REQUIRED. */
  status?: string;
  /** Where the buyer approves the order (PayPal's payer-action or approve link). */
  approvalUrl?: string;
  customId?: string;
  /** The order's authorization, once it has been authorized. */
  authorization?: AuthorizationReceipt;
  /** Refunds PayPal lists on the order; used to find a refund whose answer was lost. */
  refunds?: RefundReceipt[];
}

export interface CaptureCommand {
  paypalAuthorizationId: string;
  amountCents: number;
  finalCapture: boolean;
  /** Sent as PayPal-Request-Id; the same for every attempt of one operation. */
  requestId: string;
}

export interface CaptureReceipt extends ReportedMoney {
  paypalCaptureId?: string;
  /** COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED or FAILED. */
  status?: string;
  finalCapture?: boolean;
  createTime?: string;
  settlement?: ReportedSettlement;
}

export interface VoidCommand {
  paypalAuthorizationId: string;
  requestId: string;
}

export interface RefundCommand {
  paypalCaptureId: string;
  amountCents: number;
  requestId: string;
  /** Setti operation id, for PayPal's transaction reports. */
  customId: string;
}

export interface RefundReceipt extends ReportedMoney {
  paypalRefundId?: string;
  /** CANCELLED, FAILED, PENDING or COMPLETED. */
  status?: string;
  createTime?: string;
  settlement?: ReportedSettlement;
  /** The custom_id sent with the refund: the Setti operation id. */
  customId?: string;
}

/** HTTP status and PayPal debug id of a call, kept as evidence. */
export interface CallTrace {
  httpStatus?: number;
  debugId?: string;
}

/**
 * How a PayPal call ended:
 * - `rejected`: PayPal refused; sending the same request again gets the same answer.
 * - `unknown`: the request may have been processed; retry with the same request id to find out.
 * - `retryable`: PayPal did not process it; safe to try again later.
 */
export type PayPalResult<T> =
  | { kind: "ok"; value: T; trace?: CallTrace }
  | { kind: "rejected"; code: string; message: string; debugId?: string; trace?: CallTrace }
  | { kind: "unknown"; message: string; trace?: CallTrace }
  | { kind: "retryable"; message: string; trace?: CallTrace };

export type PayPalFailure = Exclude<PayPalResult<never>, { kind: "ok" }>;

export interface PayPalPayments {
  /** Creates an AUTHORIZE order the buyer then approves on PayPal. */
  createOrder(command: CreateOrderCommand): Promise<PayPalResult<OrderReceipt>>;
  getOrder(orderId: string): Promise<PayPalResult<OrderReceipt>>;
  /** Authorizes an approved order; the new authorization is on the returned order. */
  authorizeOrder(command: AuthorizeOrderCommand): Promise<PayPalResult<OrderReceipt>>;
  getAuthorization(paypalAuthorizationId: string): Promise<PayPalResult<AuthorizationReceipt>>;
  captureAuthorization(command: CaptureCommand): Promise<PayPalResult<CaptureReceipt>>;
  getCapture(paypalCaptureId: string): Promise<PayPalResult<CaptureReceipt>>;
  /** Releases whatever is still held on the authorization. */
  voidAuthorization(command: VoidCommand): Promise<PayPalResult<AuthorizationReceipt>>;
  refundCapture(command: RefundCommand): Promise<PayPalResult<RefundReceipt>>;
  getRefund(paypalRefundId: string): Promise<PayPalResult<RefundReceipt>>;
}

/**
 * Approves an order with PayPal's Sandbox test card instead of a buyer on PayPal.
 * Only /try uses it, to seed real holds; the money executors never receive it.
 */
export type TestCardApproval = (paypalOrderId: string) => Promise<PayPalResult<OrderReceipt>>;

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
export function classifyFailure(facts: FailureFacts): PayPalFailure {
  const { statusCode, message } = facts;
  const trace = { httpStatus: statusCode, debugId: facts.debugId };
  if (statusCode === undefined) {
    return facts.networkCode && NOT_SENT.has(facts.networkCode) ? { kind: "retryable", message, trace } : { kind: "unknown", message, trace };
  }
  if (statusCode === 429) return { kind: "retryable", message, trace };
  if (statusCode >= 500 || statusCode === 408 || statusCode === 409) return { kind: "unknown", message, trace };
  return { kind: "rejected", code: facts.code ?? `HTTP_${statusCode}`, message, debugId: facts.debugId, trace };
}
