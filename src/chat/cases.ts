import { mapleApprovedQuote } from "@/quotes/demo-quote";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import { willowQuote } from "@/quotes/willow-quote";
import type { CaseKey } from "./types";

export function isCaseKey(value: string): value is CaseKey {
  return value === "willow" || value === "maple";
}

/** Server-owned V1 contents; a request can never supply or change these prices. */
export function caseDocument(key: CaseKey): QuoteDocument {
  return key === "willow" ? willowQuote : mapleApprovedQuote;
}

/**
 * Maple's demo starts from a V1 its client already approved. Willow has none:
 * its baseline is whatever the client approves of the V1 the designer sends.
 */
export function preapprovedQuote(key: CaseKey): ApprovedQuoteReport | null {
  return key === "maple" ? mapleApprovedQuote : null;
}
