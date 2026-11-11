import { createHash } from "node:crypto";
import { approvedStart, preparedQuote, sentFromChat, type ProjectSettings } from "@/projects/settings";
import { canonical } from "@/quotes/fingerprint";
import { calculateQuoteTotals } from "@/quotes/totals";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import type { OpeningLine, OpeningQuote } from "./types";

/** The quote without its approval: what the designer sends and the client decides on. Fields are listed, so nothing else is frozen into it. */
export function withoutApproval(quote: ApprovedQuoteReport | QuoteDocument): QuoteDocument {
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
export function openingDocument(project: ProjectSettings): QuoteDocument {
  return withoutApproval(preparedQuote(project));
}

export function documentHash(document: QuoteDocument): string {
  return createHash("sha256").update(canonical(document)).digest("hex");
}

export const pendingLine = (questions = 0): OpeningLine => ({ state: "pending", note: null, decidedAt: null, by: null, questions });

type SentFields = Pick<OpeningQuote, "messageId" | "sentAt" | "sentBy" | "contentHash" | "closed" | "signedAt">;

export function openingSummary(document: QuoteDocument, lines: Record<string, OpeningLine>, sent: SentFields, draft: boolean): OpeningQuote {
  const states = document.lines.map((line) => lines[line.itemId].state);
  const approvedLines = document.lines.filter((line) => lines[line.itemId].state === "approved");
  const progress = {
    approved: approvedLines.length,
    declined: states.filter((state) => state === "declined").length,
    withdrawn: states.filter((state) => state === "withdrawn").length,
    pending: states.filter((state) => state === "pending").length,
    approvedTotalCents: calculateQuoteTotals(approvedLines).totalCents,
  };
  const totals = calculateQuoteTotals(document.lines);
  return { ...sent, status: draft ? "draft" : progress.approved ? "approved" : "sent", version: 1, lineCount: totals.lineCount, totalCents: totals.totalCents, progress };
}

/** A project before anything is sent: a draft V1, or the V1 approved before Setti. */
export function defaultOpening(project: ProjectSettings): OpeningQuote {
  const document = openingDocument(project);
  const preapproved = approvedStart(project);
  const lines = Object.fromEntries(document.lines.map((line) => [line.itemId, preapproved ? { ...pendingLine(), state: "approved" as const } : pendingLine()]));
  return openingSummary(document, lines, { messageId: null, sentAt: null, sentBy: null, contentHash: null, closed: false, signedAt: preapproved?.approvedAt ?? null }, sentFromChat(project));
}
