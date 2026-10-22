/**
 * A project's first quote (V1) and how it reaches the client. Willow's V1 is a
 * draft the designer sends from the project chat; Maple's demo starts from a V1
 * the client already approved.
 */
import type { CaseKey } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";

/** Approval of a sent V1 is the next step of the flow; until then a sent V1 stays "sent". */
export type OpeningStatus = "draft" | "sent" | "approved";

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
}

/** What the quote report shows: the document plus how far it has got with the client. */
export interface QuoteView {
  projectKey: CaseKey;
  opening: OpeningQuote;
  document: QuoteDocument;
  /** Only for a V1 the demo starts from as approved. */
  approval: { approvedBy: string; approvedAt: string } | null;
}

export const QUOTE_MESSAGE_MAX = 2_000;

export function sentFromChat(key: CaseKey): boolean {
  return key === "willow";
}
