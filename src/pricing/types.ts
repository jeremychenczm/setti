import type { CaseKey, CaseMessage, ChangeDraft, DraftChange, FromV1, ProductPage } from "@/chat/types";
import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteCategory } from "@/quotes/types";
import type { QuoteTotals } from "@/quotes/totals";
import type { ClientDecision } from "@/approval/types";
import type { ReviewCarryOver } from "./carry-over";
import type { FieldChange } from "./review-diff";

/** "modified": the supplier re-makes or re-sizes the item that was already made, instead of cancelling or taking it back. */
export type OldItemHandling = "pending" | "not_ordered" | "cancelled" | "modified" | "returned" | "retained" | "not_applicable";

/** What a non-refundable cost of the old item is; "other" is explained in the old-item note. */
export type NonRefundableFeeKind = "restocking_fee" | "fabrication_fee" | "shipping" | "material_cost" | "cancellation_fee" | "other";

export interface NonRefundableFee {
  kind: NonRefundableFeeKind;
  amountCents: number;
}

/** Editable amounts stay nullable until a designer explicitly checks them. */
export interface PricingItem {
  name: string;
  vendor: string;
  brand: string | null;
  sku: string;
  specification: string;
  category: QuoteCategory;
  room: string;
  quantity: number;
  unitLabel: string;
  currency: string | null;
  unitPriceCents: number | null;
  taxCents: number | null;
  freightCents: number | null;
  sourceUrl: string | null;
  returnPolicy: string;
  returnable: boolean | null;
  restockingFeeBps: number | null;
  customMade: boolean;
  leadTimeDays: number | null;
}

export interface PricingChangeInput {
  key: string;
  action: DraftChange["action"];
  itemId: string | null;
  after: PricingItem | null;
  priceEvidence: string;
  confirmed: boolean;
  oldItemHandling: OldItemHandling;
  /** Total retained old-item cost / handling charge including its applicable fees: the sum of the fees below. */
  oldItemCostCents: number | null;
  /** The non-refundable costs that make up that total, by type; an amount stays null until the designer enters it. */
  oldItemFees: { kind: NonRefundableFeeKind; amountCents: number | null }[];
  oldItemNote: string;
  /** Fixed by the draft: the V1 line this change brings back. */
  fromV1?: FromV1;
}

export interface PricingIssue {
  id: string;
  label: string;
  resolved: boolean;
  note: string;
}

/**
 * Why a version changes the agreement: it came out of the conversation with the
 * client ("client"), or a supplier's notice changed a price or term ("vendor");
 * the client confirms the version either way before any money moves.
 * "designer" is only read: versions frozen before the client's requests and the
 * studio's proposals became one "client conversation" source still carry it.
 */
export interface ChangeSource {
  kind: "client" | "designer" | "vendor";
  /** For a supplier notice: the supplier, and what its notice says. Empty otherwise. */
  vendor: string;
  notice: string;
}

export interface PricingInput {
  baselineFingerprint: string;
  title: string;
  changes: PricingChangeInput[];
  issues: PricingIssue[];
  terms: string;
  reviewNotes: string;
  /** Saved reviews from before sources were recorded have none; the draft's author decides then. */
  source?: ChangeSource;
}

export interface PricingPreview {
  baselineTotals: QuoteTotals;
  proposedTotals: QuoteTotals | null;
  deltaTotalCents: number | null;
  problems: string[];
  ready: boolean;
}

/**
 * The draft's own proposal, priced as the pricing page first fills it in, kept
 * with a saved review. It is the common starting point for telling the
 * designer's edits apart from the draft's later changes.
 */
export interface DraftProposal {
  quoteId: string;
  input: PricingInput;
}

export interface PricingReview {
  id: string;
  sourceDraftId: string;
  sourceDraftRevision: number;
  version: number;
  input: PricingInput;
  createdAt: string;
  updatedAt: string;
}

export interface FinalQuoteLine extends Omit<PricingItem, "unitPriceCents" | "taxCents" | "freightCents" | "currency"> {
  itemId: string;
  unitPriceCents: number;
  taxCents: number;
  freightCents: number;
  currency: "USD";
  origin: "unchanged" | "changed" | "old_item_cost";
}

export interface ReviewedChange {
  key: string;
  action: DraftChange["action"];
  itemId: string | null;
  before: ApprovedQuoteLine | null;
  after: FinalQuoteLine | null;
  oldItemHandling: OldItemHandling;
  oldItemCostCents: number;
  /** The non-refundable costs that make up oldItemCostCents. Versions frozen before fees had types have none. */
  oldItemFees?: NonRefundableFee[];
  oldItemNote: string;
  priceEvidence: string;
  /** The V1 line this change brings back, shown to the client with the change. */
  fromV1?: FromV1;
  /** For a line that comes back from V1: the fields that differ from V1 as it was sent. */
  changesFromV1?: FieldChange[];
}

/** Everything a client reads is frozen here, including names, terms and sources. */
export interface PricingDocumentBody {
  baselineFingerprint: string;
  projectKey: CaseKey;
  basedOnQuoteId: string;
  basedOnVersion: number;
  projectName: string;
  clientName: string;
  designerName: string;
  currency: "USD";
  isDemo: true;
  title: string;
  sourceDraftId: string;
  sourceDraftRevision: number;
  changes: ReviewedChange[];
  lines: FinalQuoteLine[];
  baselineLines: ApprovedQuoteLine[];
  baselineTotals: QuoteTotals;
  totals: QuoteTotals;
  deltaTotalCents: number;
  terms: string;
  reviewNotes: string;
  issues: PricingIssue[];
  constraints: string[];
  sourceMessages: Pick<CaseMessage, "id" | "actor" | "text" | "createdAt">[];
  sources: ProductPage[];
  /** Why this version changes the agreement. Versions issued before sources were recorded have none. */
  source?: ChangeSource;
}

export interface FrozenChangeOrder extends PricingDocumentBody {
  id: string;
  version: number;
  issuedAt: string;
  reviewId: string;
  reviewVersion: number;
  revisionId: string;
  revisionContentHash: string;
  contentHash: string;
}

export interface ChangeOrderView {
  order: FrozenChangeOrder;
  status: "awaiting_client_confirmation" | "approved" | "declined" | "superseded";
  decision?: ClientDecision | null;
}

export interface ChangeOrderSummary {
  id: string;
  version: number;
  issuedAt: string;
  totalCents: number;
  deltaTotalCents: number;
  /** The saved review version it was issued from. */
  reviewVersion: number;
  status: ChangeOrderView["status"];
}

export interface PricingWorkspace {
  caseId: string;
  projectKey: CaseKey;
  quote: ApprovedQuoteReport;
  sourceDraft: ChangeDraft | null;
  review: PricingReview | null;
  preview: PricingPreview | null;
  stale: boolean;
  /** When the draft changed after the review was saved: the review moved onto the current draft, unsaved. */
  carryOver?: ReviewCarryOver | null;
  orders: ChangeOrderSummary[];
}

export interface SavePricingInput {
  sourceDraftId: string;
  sourceDraftRevision: number;
  expectedVersion: number | null;
  input: PricingInput;
}

export interface IssuePricingInput {
  reviewId: string;
  expectedVersion: number;
}

export interface PricingStore {
  getWorkspace(sessionId: string, key: CaseKey): Promise<PricingWorkspace>;
  saveReview(sessionId: string, key: CaseKey, input: SavePricingInput): Promise<PricingWorkspace>;
  issueReview(sessionId: string, key: CaseKey, input: IssuePricingInput): Promise<ChangeOrderView>;
  getOrder(id: string): Promise<ChangeOrderView | null>;
}
