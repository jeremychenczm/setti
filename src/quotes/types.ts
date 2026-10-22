/**
 * An approved quote describes agreed prices and terms. Approval does not mean
 * that a payment was authorized, captured or refunded.
 */
export type QuoteCategory = "furniture" | "service";

export interface QuoteSource {
  kind: "demo" | "public_reference" | "estimate";
  reference: string;
  name: string;
  note: string;
  url?: string;
  /** Date on which the reference price was checked, not a price guarantee. */
  checkedAt?: string;
  priceNote?: string;
  returnPolicyUrl?: string;
}

export interface QuoteLineApproval {
  status: "approved";
  approvedBy: string;
  approvedAt: string;
  signature: string;
  isDemo: true;
}

export interface ApprovedQuoteLine {
  /** Stable identity of the item, independent of row order or quote version. */
  itemId: string;
  name: string;
  vendor: string;
  category: QuoteCategory;
  room: string;
  sku: string;
  specification: string;
  /** Whole units. Must be a positive safe integer. */
  quantity: number;
  /** Unit being purchased, for example each, hour or 2-pack. */
  unitLabel?: string;
  unitPriceCents: number;
  /** Total tax for this line, not tax per unit. */
  taxCents: number;
  /** Total freight for this line, not freight per unit. */
  freightCents: number;
  source: QuoteSource;
  /** Null means that delivery lead time is unknown or does not apply. */
  leadTimeDays: number | null;
  returnPolicy: string;
  /** Basis points: 2000 means 20%. Null means the fee has not been confirmed. */
  restockingFeeBps: number | null;
  customMade: boolean;
  /** Null means that return or cancellation eligibility needs review. */
  nonReturnable: boolean | null;
  approval: QuoteLineApproval;
}

/** A quote line as the designer sends it, before the client has decided on it. */
export type QuoteLine = Omit<ApprovedQuoteLine, "approval">;

/** A whole quote as the designer sends it: no approval, signature or approval date. */
export type QuoteDocument = Omit<ApprovedQuoteReport, "status" | "approvedAt" | "approvedBy" | "signature" | "lines"> & {
  lines: readonly QuoteLine[];
};

export interface ApprovedQuoteReport {
  id: string;
  version: number;
  projectId: string;
  projectName: string;
  room: string;
  clientName: string;
  designerName: string;
  currency: "USD";
  status: "approved";
  approvedAt: string;
  approvedBy: string;
  signature: string;
  isDemo: true;
  demoNotice: string;
  paymentNote: string;
  assumptions: readonly string[];
  lines: readonly ApprovedQuoteLine[];
}
