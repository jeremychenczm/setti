import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { revisions } from "../db/schema";
import { caseDocument, preapprovedQuote } from "../chat/cases";
import type { CaseKey } from "../chat/types";
import { changeOrders, pricingCases } from "../pricing/schema";
import type { FrozenChangeOrder } from "../pricing/types";
import { approvedBaseline, readOpening } from "../opening/read";
import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteDocument } from "../quotes/types";
import { changeOrderDecisions } from "./schema";

type ConfirmedBy = Pick<typeof changeOrderDecisions.$inferSelect, "clientName" | "signature" | "decidedAt">;

/** Restore the complete signed snapshot, including unchanged and old-item cost lines. */
export function approvedQuoteFromOrder(order: FrozenChangeOrder, decision: ConfirmedBy, original: QuoteDocument = caseDocument(order.projectKey)): ApprovedQuoteReport {
  const approvedAt = decision.decidedAt.toISOString();
  const approval = { status: "approved" as const, approvedBy: decision.clientName, approvedAt, signature: decision.signature, isDemo: true as const };
  const lines: ApprovedQuoteLine[] = order.lines.map((line) => {
    const previous = order.baselineLines.find((item) => item.itemId === line.itemId);
    const source = line.origin === "unchanged" && previous ? structuredClone(previous.source) : {
      kind: line.sourceUrl ? "public_reference" as const : "estimate" as const,
      reference: `${order.id}:${line.itemId}`,
      name: line.vendor,
      note: `Designer-reviewed price in the client-confirmed demo V${order.version}. ${line.brand ? `Brand: ${line.brand}.` : ""}`.trim(),
      ...(line.sourceUrl ? { url: line.sourceUrl } : {}),
      checkedAt: order.issuedAt,
    };
    return {
      itemId: line.itemId, name: line.name, vendor: line.vendor, category: line.category, room: line.room,
      sku: line.sku, specification: line.specification, quantity: line.quantity, unitLabel: line.unitLabel,
      unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
      source, leadTimeDays: line.leadTimeDays, returnPolicy: line.returnPolicy,
      restockingFeeBps: line.restockingFeeBps, customMade: line.customMade,
      nonReturnable: line.returnable === null ? null : !line.returnable,
      approval: { ...approval },
    };
  });
  return {
    ...original, status: "approved", id: order.id, version: order.version, projectName: order.projectName,
    clientName: order.clientName, designerName: order.designerName,
    approvedAt, approvedBy: decision.clientName, signature: decision.signature,
    demoNotice: "Demo client confirmation of a frozen quote; this is not identity verification or a payment receipt.",
    paymentNote: "Client confirmation records scope and prices. Authorization, capture and refund are separate payment records.",
    assumptions: [order.terms, ...order.constraints, ...(order.reviewNotes ? [order.reviewNotes] : [])],
    lines,
  };
}

/**
 * The caller holds the case lock while changing or using this baseline: the
 * latest client-confirmed change order, else Maple's demo-approved V1, else the
 * Willow V1 lines the client approved. Null while the client has approved nothing.
 */
export async function currentCaseQuote(db: Pick<Db, "select">, caseId: string, key: CaseKey): Promise<ApprovedQuoteReport | null> {
  const [approved] = await db.select({ document: changeOrders.document, clientName: changeOrderDecisions.clientName, signature: changeOrderDecisions.signature, decidedAt: changeOrderDecisions.decidedAt })
    .from(changeOrders)
    .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
    .innerJoin(changeOrderDecisions, and(eq(changeOrderDecisions.orderId, changeOrders.id), eq(changeOrderDecisions.revisionId, revisions.id)))
    .where(and(eq(changeOrders.caseId, caseId), eq(changeOrderDecisions.decision, "approved")))
    .orderBy(desc(revisions.number)).limit(1);
  const [bridge] = await db.select({ quote: pricingCases.baselineQuote }).from(pricingCases).where(eq(pricingCases.caseId, caseId));
  if (approved) return approvedQuoteFromOrder(approved.document, approved, bridge?.quote ?? caseDocument(key));
  return bridge?.quote ?? preapprovedQuote(key) ?? approvedBaseline(await readOpening(db, { id: caseId, projectKey: key }));
}
