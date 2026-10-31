/** Prepared project histories. These identities never enter the live payment APIs. */
export type StudioStage = "draft" | "awaiting_client" | "awaiting_supplier" | "awaiting_credit" | "declined" | "settled";
export type StudioIndustry = "Restaurant" | "Coffee shop" | "Retail" | "Residential" | "Office" | "Salon";
export type StudioLineKind = "Design service" | "Material" | "Furniture" | "Delivery" | "Retained cost";

export interface StudioLine {
  id: string;
  name: string;
  kind: StudioLineKind;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  specification: string;
  source: string;
}
export interface StudioQuote {
  version: number;
  status: "draft" | "approved" | "awaiting_client" | "declined";
  lines: StudioLine[];
  note: string;
}
export interface StudioMessage {
  actor: "designer" | "client";
  text: string;
  at: string;
}
export interface StudioMoneyLine {
  lineId: string;
  heldCents: number;
  capturedCents: number;
  refundedCents: number;
  releasedCents: number;
  awaitingCreditCents: number;
}
export interface StudioCase {
  id: string;
  name: string;
  industry: StudioIndustry;
  location: string;
  client: { name: string; title: string };
  summary: string;
  stage: StudioStage;
  focus: string[];
  quote: StudioQuote;
  proposal?: StudioQuote;
  messages: StudioMessage[];
  money: StudioMoneyLine[];
  timeline: { date: string; title: string; text: string }[];
  next: { actor: string; title: string; detail: string };
}

export const STUDIO_STAGES: Record<StudioStage, { label: string; tone: "neutral" | "amber" | "green"; description: string }> = {
  draft: { label: "Quote in progress", tone: "neutral", description: "The scope is still being discussed. Nothing has been sent for approval." },
  awaiting_client: { label: "Awaiting client", tone: "amber", description: "A revised quote is with the client. The earlier approved scope still stands." },
  awaiting_supplier: { label: "Awaiting supplier", tone: "amber", description: "The client approved the scope. Goods are held while the supplier checks the order." },
  awaiting_credit: { label: "Awaiting return credit", tone: "amber", description: "The return is agreed. The supplier's credit is still needed before the refund." },
  declined: { label: "Revision declined", tone: "neutral", description: "The client declined the revision. The approved version and its payments remain in place." },
  settled: { label: "Settled", tone: "green", description: "The agreed purchases, retained costs and refund are recorded. Nothing remains held." },
};

export const studioLineTotal = (line: StudioLine) => line.quantity * line.unitPriceCents;
export const studioQuoteTotal = (quote: StudioQuote) => quote.lines.reduce((total, line) => total + studioLineTotal(line), 0);
export function studioMoneyTotals(project: StudioCase) {
  return project.money.reduce((total, line) => ({
    held: total.held + line.heldCents,
    captured: total.captured + line.capturedCents,
    refunded: total.refunded + line.refundedCents,
    released: total.released + line.releasedCents,
    awaitingCredit: total.awaitingCredit + line.awaitingCreditCents,
    netPaid: total.netPaid + line.capturedCents - line.refundedCents,
  }), { held: 0, captured: 0, refunded: 0, released: 0, awaitingCredit: 0, netPaid: 0 });
}

export function studioLineState(project: StudioCase, line: StudioMoneyLine): string {
  if (line.awaitingCreditCents > 0) return "Awaiting supplier credit";
  if (line.heldCents > 0) return "Held · not charged";
  if (line.refundedCents > 0) return "Refund completed";
  if (line.capturedCents > 0) return "Paid";
  return project.stage === "draft" ? "Not requested" : "Not yet funded";
}
