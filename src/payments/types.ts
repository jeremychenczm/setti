import type { FundingPlan } from "@/approval/funding";

export type PaymentStepKind = "authorize" | "supplier_confirmation" | "capture" | "void" | "supplier_credit" | "refund";

/** A money step the server allows (or explains why not) for one line of the confirmed version. */
export interface PaymentStep {
  kind: PaymentStepKind;
  actor: "client" | "designer";
  amountCents: number;
  available: boolean;
  note: string;
}

export interface HoldView {
  id: string;
  paypalOrderId: string;
  paypalAuthorizationId: string;
  amountCents: number;
  status: "created" | "partially_captured" | "captured" | "voided" | "expired";
  capturedCents: number;
  heldCents: number;
  releasedCents: number;
  /** Version the hold was created for; later versions may reuse it for the same business item. */
  version: number | null;
  createdAt: string;
  honorExpiresAt: string | null;
  expiresAt: string | null;
}

export interface CaptureView {
  id: string;
  paypalCaptureId: string;
  authorizationId: string | null;
  amountCents: number;
  status: "completed" | "pending" | "declined";
  finalCapture: boolean;
  refundedCents: number;
  pendingRefundCents: number;
  createdAt: string;
}

export interface RefundView {
  id: string;
  paypalRefundId: string;
  captureId: string;
  amountCents: number;
  status: "pending" | "completed" | "failed";
  createdAt: string;
}

export interface PaymentLineView {
  itemId: string;
  side: "baseline" | "proposed";
  label: string;
  category: "furniture" | "service";
  changed: boolean;
  change: "quantity" | "remove" | "replace" | "add" | null;
  targetCents: number;
  heldCents: number;
  capturedCents: number;
  refundedCents: number;
  releasedCents: number;
  holds: HoldView[];
  captures: CaptureView[];
  refunds: RefundView[];
  steps: PaymentStep[];
}

export interface CallView {
  step: string;
  outcome: "ok" | "rejected" | "unknown" | "retryable";
  httpStatus: number | null;
  debugId: string | null;
  resourceId: string | null;
  resourceStatus: string | null;
  amountCents: number | null;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
}

export interface OperationView {
  id: string;
  kind: "authorize" | "capture" | "void" | "refund" | "reauthorize";
  status: "pending" | "succeeded" | "failed" | "unknown";
  amountCents: number;
  itemLabel: string | null;
  version: number | null;
  requestId: string;
  attempts: number;
  paypalOrderId: string | null;
  /** Buyer approval link, shown only to the owning session while the checkout is open. */
  approvalUrl: string | null;
  paypalResourceId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  calls: CallView[];
}

export interface PaymentsWorkspace {
  orderId: string;
  version: number;
  /** True only for the latest client-confirmed version, the one new payment steps start from. */
  current: boolean;
  canAct: boolean;
  reason: string | null;
  environment: "sandbox";
  plan: FundingPlan | null;
  /** Lines this version changes, plus any line that already has PayPal money. */
  lines: PaymentLineView[];
  /** Lines outside this change's payment scope; Setti shows them but runs no money step for them here. */
  others: { lineCount: number; targetCents: number };
  operations: OperationView[];
}
