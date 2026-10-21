import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { willowApprovedQuote } from "@/quotes/willow-quote";
import type { CaseKey } from "./types";

export function isCaseKey(value: string): value is CaseKey {
  return value === "willow" || value === "maple";
}

/** Server-owned demo baseline; a request can never supply or change these prices. */
export function caseQuote(key: CaseKey) {
  return key === "willow" ? willowApprovedQuote : mapleApprovedQuote;
}
