import { createHash } from "node:crypto";
import { caseQuote } from "@/chat/cases";
import type { CaseKey } from "@/chat/types";
import { canonical } from "@/quotes/fingerprint";
import { calculateQuoteTotals } from "@/quotes/totals";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import { sentFromChat, type OpeningQuote } from "./types";

/** The quote without its approval: what the designer sends and the client decides on. Fields are listed, so nothing else is frozen into it. */
export function withoutApproval(quote: ApprovedQuoteReport): QuoteDocument {
  return {
    id: quote.id, version: quote.version, projectId: quote.projectId, projectName: quote.projectName, room: quote.room,
    clientName: quote.clientName, designerName: quote.designerName, currency: quote.currency, isDemo: quote.isDemo,
    demoNotice: quote.demoNotice, paymentNote: quote.paymentNote, assumptions: [...quote.assumptions],
    lines: quote.lines.map((line) => ({
      itemId: line.itemId, name: line.name, vendor: line.vendor, category: line.category, room: line.room, sku: line.sku,
      specification: line.specification, quantity: line.quantity, unitLabel: line.unitLabel, unitPriceCents: line.unitPriceCents,
      taxCents: line.taxCents, freightCents: line.freightCents, source: structuredClone(line.source), leadTimeDays: line.leadTimeDays,
      returnPolicy: line.returnPolicy, restockingFeeBps: line.restockingFeeBps, customMade: line.customMade, nonReturnable: line.nonReturnable,
    })),
  };
}

/** The project's prepared V1, as it would be sent now. */
export function openingDocument(key: CaseKey): QuoteDocument {
  return withoutApproval(caseQuote(key));
}

export function documentHash(document: QuoteDocument): string {
  return createHash("sha256").update(canonical(document)).digest("hex");
}

export function openingSummary(document: QuoteDocument, sent: { status: OpeningQuote["status"]; messageId: string | null; sentAt: string | null; sentBy: string | null; contentHash: string | null }): OpeningQuote {
  const totals = calculateQuoteTotals(document.lines);
  return { ...sent, version: 1, lineCount: totals.lineCount, totalCents: totals.totalCents };
}

/** A case before anything is sent: Willow's V1 is a draft, Maple's starts approved. */
export function defaultOpening(key: CaseKey): OpeningQuote {
  return openingSummary(openingDocument(key), { status: sentFromChat(key) ? "draft" : "approved", messageId: null, sentAt: null, sentBy: null, contentHash: null });
}
