import type { FundingPlan } from "@/approval/funding";
import type { CaseKey } from "@/chat/types";
import type { SettlementView } from "./fees";

export type RecordedSettlement = SettlementView & { observedAt: string | null };

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
  settlement?: RecordedSettlement;
  id: string;
  paypalCaptureId: string;
  authorizationId: string | null;
  amountCents: number;
  status: "completed" | "pending" | "declined";
  finalCapture: boolean;
  refundedCents: number;
  pendingRefundCents: number;
  /** The operation that recorded it, to reconcile a pending result. */
  operationId: string | null;
  createdAt: string;
}

export interface RefundView {
  settlement?: RecordedSettlement;
  id: string;
  paypalRefundId: string;
  captureId: string;
  amountCents: number;
  status: "pending" | "completed" | "failed";
  operationId: string | null;
  createdAt: string;
}

/** A supplier event the designer recorded for this version (demo). */
export interface SupplierEventView {
  id: string;
  kind: "order_confirmed" | "credit_confirmed";
  quantity: number | null;
  unitPriceCents: number | null;
  taxCents: number | null;
  freightCents: number | null;
  totalCents: number;
  inStock: boolean | null;
  leadTimeDays: number | null;
  reference: string;
  note: string;
  isDemo: true;
  createdAt: string;
}

export interface PaymentLineView {
  itemId: string;
  side: "baseline" | "proposed";
  /** Stable ledger identity; old and replacement products may share a quote itemId. */
  businessItemId?: string | null;
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
  /** Frozen purchase terms or retained fees that the supplier confirmation must match. */
  confirmedTerms: { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; purpose: "order" | "retained_cost" } | null;
  supplierEvents: SupplierEventView[];
  /** Frozen return condition, retained even when another item's unresolved operation blocks actions. */
  refundRequiresSupplierCredit?: boolean;
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
  /** Stable ledger identity for matching an operation to exactly one displayed product. */
  businessItemId?: string | null;
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
  canContinue?: boolean;
  canCheck?: boolean;
  canCancel?: boolean;
  paypalResourceId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  calls: CallView[];
}

export interface PaymentsWorkspace {
  projectKey: CaseKey;
  orderId: string;
  version: number;
  /** True only for the latest client-confirmed version, the one new payment steps start from. */
  current: boolean;
  canAct: boolean;
  /** The owning session may reconcile existing operations even after this version is superseded. */
  canReconcile: boolean;
  reason: string | null;
  environment: "sandbox";
  plan: FundingPlan | null;
  /** Lines this version changes, plus any line that already has PayPal money. */
  lines: PaymentLineView[];
  /** Lines outside this change's payment scope; Setti shows them but runs no money step for them here. */
  others: { lineCount: number; targetCents: number };
  operations: OperationView[];
}
