/**
 * A project's first quote (V1) and how it reaches the client. Willow's V1 is a
 * draft the designer sends from the project chat, and the client decides on it
 * line by line; Maple's demo starts from a V1 the client already approved.
 */
import type { CaseKey } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";

/** "approved" means the client approved at least one line: there is a baseline to pay for and change. */
export type OpeningStatus = "draft" | "sent" | "approved";

/** Where one V1 line is. A declined line can only come back in a new version. */
export type LineState = "approved" | "declined" | "withdrawn" | "pending";

export interface OpeningLine {
  state: LineState;
  /** The client's reason for declining. */
  note: string | null;
  /** When the client decided, or the designer dropped the line. */
  decidedAt: string | null;
  /** The client who signed the decision, or the designer who dropped the line. */
  by: string | null;
  /** Chat messages tagged with this line. */
  questions: number;
}

export interface OpeningProgress {
  approved: number;
  declined: number;
  withdrawn: number;
  pending: number;
  approvedTotalCents: number;
}

export interface OpeningQuote {
  status: OpeningStatus;
  version: 1;
  /** The chat message that carries the quote card. */
  messageId: string | null;
  sentAt: string | null;
  sentBy: string | null;
  /** SHA-256 of the frozen document, set when it is sent. */
  contentHash: string | null;
  lineCount: number;
  totalCents: number;
  progress: OpeningProgress;
  /** A later version replaced V1, so it takes no more decisions. */
  closed: boolean;
  /** The client's most recent signature on V1. */
  signedAt: string | null;
}

/** What the quote report shows: the document plus how far it has got with the client. */
export interface QuoteView {
  projectKey: CaseKey;
  opening: OpeningQuote;
  document: QuoteDocument;
  /** Only for a V1 the demo starts from as approved. */
  approval: { approvedBy: string; approvedAt: string } | null;
  /** Quote item id → that line's state. */
  lines: Record<string, OpeningLine>;
}

/** One signature: the lines the client decides now. Undecided lines can be signed later. */
export interface SignOpeningInput {
  /** Kept across retries, so a lost response never records the decisions twice. */
  signingId: string;
  contentHash: string;
  signature: string;
  acknowledged: boolean;
  decisions: { itemId: string; decision: "approved" | "declined"; note?: string }[];
}

export const QUOTE_MESSAGE_MAX = 2_000;
export const DECLINE_REASON_MAX = 1_000;

/** The client's name as typed to sign: the document's name without its demo label. */
export function clientSignatureName(document: Pick<QuoteDocument, "clientName">): string {
  return document.clientName.replace(/\s*\(demo client\)$/, "");
}
