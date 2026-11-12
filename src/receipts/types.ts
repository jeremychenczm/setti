/**
 * A version receipt: one version of a project's quote as the client decided
 * it, the PayPal steps that followed, and the fingerprints a reader needs to
 * check it. Before the client signs, the same record is the formal quote of
 * the version as sent. It feeds the receipt page and the JSON download. Every
 * amount is in US cents.
 */
import type { FundingAction } from "../approval/funding";
import type { CaseKey } from "../chat/types";
import type { LineState } from "../opening/types";
import type { ChangeSource, FrozenChangeOrder, NonRefundableFee, OldItemHandling, ReviewedChange } from "../pricing/types";
import type { LineSnapshot } from "../quotes/hash";
import type { QuoteDocument } from "../quotes/types";

export const RECEIPT_FORMAT = "setti-version-receipt/1";

/** Left out of every receipt on purpose. */
export const RECEIPT_NOT_INCLUDED = ["payer account details", "PayPal approval links", "internal request ids"] as const;

/** One quoted item as the receipt names it. */
export interface ReceiptItem {
  itemId: string;
  name: string;
  vendor: string;
  sku: string;
  quantity: number;
  unitLabel: string;
  totalCents: number;
}

/** A V1 line and the client's decision on it. */
export interface OpeningReceiptLine extends ReceiptItem {
  decision: LineState;
  /** The client's reason for declining. */
  note: string | null;
  decidedAt: string | null;
  /** The client who decided, or the designer who dropped the line. */
  decidedBy: string | null;
  /** The signing the decision belongs to; null for a sample approval or an undecided line. */
  signingId: string | null;
}

/** One change a later version makes. */
export interface ChangeReceiptLine {
  itemId: string | null;
  action: ReviewedChange["action"];
  before: ReceiptItem | null;
  after: ReceiptItem | null;
  /** What happens to the item the change replaces or removes; fees are empty for versions frozen before fees had types. */
  oldItem: { handling: OldItemHandling; retainedCents: number; fees: NonRefundableFee[]; note: string } | null;
}

export type ReceiptAgreement =
  | { kind: "opening"; lines: OpeningReceiptLine[] }
  | {
    kind: "change";
    changes: ChangeReceiptLine[];
    unchanged: ReceiptItem[];
    /** Why the version changes the agreement, with the chat messages it came from. Versions frozen before sources were kept have no kind. */
    source: { kind: ChangeSource["kind"] | null; vendor: string; notice: string; messages: { id: string; actor: string; text: string; createdAt: string }[] };
    terms: string;
  };

/** One time the client signed this version. */
export interface ReceiptSignature {
  /** "signed": typed in Setti by the client. "sample": the demo's approval of a V1 that came already approved. */
  method: "signed" | "sample";
  signingId: string | null;
  name: string;
  signature: string;
  at: string;
  decision: "approved" | "declined" | "mixed" | "changes_requested";
  note: string | null;
  /** For a V1: the lines this signing decided. */
  itemIds: string[];
  /** Fingerprints recorded with the signature. */
  contentHash: string | null;
  revisionContentHash: string | null;
  /** Whether those fingerprints are this version's; null when nothing was recorded to compare. */
  matches: boolean | null;
}

/** One PayPal step for an item of this version. */
export interface ReceiptPayment {
  at: string;
  /** The quote line, when the step belongs to one. */
  itemId: string | null;
  item: string;
  action: "held" | "charged" | "released" | "refunded" | "renewed";
  amountCents: number;
  paypal: { authorizationId?: string; captureId?: string; refundId?: string };
  /** The version the step carried out; earlier versions' steps on this version's items are brought forward. */
  version: number | null;
  broughtForward: boolean;
  /** When PayPal last confirmed the result. */
  confirmed: { at: string; via: "webhook" | "readback" | "response"; status: string | null } | null;
}

/** What remained to happen when the receipt was issued, for the version in force. */
export interface ReceiptPending {
  actions: Pick<FundingAction, "kind" | "itemId" | "side" | "label" | "amountCents" | "timing" | "reason">[];
  /** Why some steps could not be worked out yet. */
  blockers: string[];
  position: { heldCents: number; capturedCents: number; refundedCents: number };
}

export interface VersionReceipt {
  format: typeof RECEIPT_FORMAT;
  /** Project, version and the first 8 characters of the version's fingerprint. */
  receiptNo: string;
  issuedAt: string;
  project: { key: CaseKey; name: string; room: string; client: string; designer: string };
  version: {
    number: number;
    basedOn: number | null;
    /**
     * A V1 is approved, partly approved or declined line by line; a later version is approved or sent back as a whole.
     * Before any signature, a sent version is awaiting it, or superseded once a newer version replaced it unsigned.
     */
    status: "approved" | "partly_approved" | "declined" | "changes_requested" | "awaiting_signature" | "superseded";
    /** The confirmed version that replaced this one. */
    replacedBy: number | null;
    sentAt: string | null;
    sentBy: string | null;
    /** SHA-256 of `document` as canonical JSON. Null for a V1 the demo imports as already approved. */
    contentHash: string | null;
    /** The version exactly as it was frozen and hashed. */
    document: QuoteDocument | Omit<FrozenChangeOrder, "contentHash">;
    /** The agreed lines the signatures are bound to; `contentHash` is `hashRevision(lines)`. */
    revision: { contentHash: string; lines: LineSnapshot[] } | null;
  };
  /** Empty while the version awaits the client's signature. */
  signatures: ReceiptSignature[];
  agreement: ReceiptAgreement;
  totals: { previousCents: number | null; totalCents: number; differenceCents: number | null };
  payments: ReceiptPayment[];
  /** Null for a version that was replaced or not agreed. */
  pending: ReceiptPending | null;
  notIncluded: typeof RECEIPT_NOT_INCLUDED;
}
