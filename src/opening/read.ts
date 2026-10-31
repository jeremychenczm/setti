/**
 * Reads a case's V1 as the client and designer see it: the frozen document,
 * each line's decision, and the approved baseline that payments and later
 * versions start from. Decisions come only from the client's signed approval
 * records; nothing here infers an approval.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { caseDocument, preapprovedQuote } from "../chat/cases";
import { chatMessages } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { approvals, revisionLines, revisions } from "../db/schema";
import { itemMappingKey } from "../pricing/document";
import { pricingCases } from "../pricing/schema";
import type { ApprovedQuoteReport } from "../quotes/types";
import { openingSummary, pendingLine, withoutApproval } from "./document";
import { openingQuotes, openingWithdrawals } from "./schema";
import type { OpeningLine, QuoteView } from "./types";

type Reader = Pick<Db, "select">;
type ApprovalRow = typeof approvals.$inferSelect;

export interface OpeningRead extends Omit<QuoteView, "projectKey"> {
  /** The business V1 revision, once V1 was sent from the chat. */
  revision: { id: string; status: string; contentHash: string } | null;
  /** Quote item id → business revision line id of V1. */
  lineIds: Map<string, string>;
  /** Quote item id → the client's signed decision on that line. */
  decisions: Map<string, ApprovalRow>;
}

export async function readOpening(db: Reader, row: { id: string; projectKey: CaseKey }): Promise<OpeningRead> {
  const [bridge] = await db.select().from(pricingCases).where(eq(pricingCases.caseId, row.id));
  const [sent] = await db.select().from(openingQuotes).where(eq(openingQuotes.caseId, row.id));
  const quote = bridge?.baselineQuote ?? preapprovedQuote(row.projectKey);
  if (quote && !sent) {
    const document = withoutApproval(quote);
    const lines = Object.fromEntries(document.lines.map((line) => [line.itemId, { state: "approved", note: null, decidedAt: quote.approvedAt, by: quote.approvedBy, questions: 0 } satisfies OpeningLine]));
    return {
      document, lines, approval: { approvedBy: quote.approvedBy, approvedAt: quote.approvedAt }, revision: null, lineIds: new Map(), decisions: new Map(),
      opening: openingSummary(document, lines, { messageId: null, sentAt: null, sentBy: null, contentHash: null, closed: false, signedAt: quote.approvedAt }, false),
    };
  }

  if (!sent) {
    const document = caseDocument(row.projectKey);
    const lines = Object.fromEntries(document.lines.map((line) => [line.itemId, pendingLine()]));
    return { document, lines, approval: null, revision: null, lineIds: new Map(), decisions: new Map(), opening: openingSummary(document, lines, { messageId: null, sentAt: null, sentBy: null, contentHash: null, closed: false, signedAt: null }, true) };
  }

  const document = sent.document;
  const [revision] = bridge ? await db.select().from(revisions).where(eq(revisions.id, bridge.baselineRevisionId)) : [];
  const revisionRows = revision ? await db.select().from(revisionLines).where(eq(revisionLines.revisionId, revision.id)) : [];
  const lineByItem = new Map(revisionRows.map((line) => [line.itemId, line.id]));
  const lineIds = new Map<string, string>();
  for (const line of document.lines) {
    const businessItem = bridge?.itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    const lineId = businessItem ? lineByItem.get(businessItem) : undefined;
    if (lineId) lineIds.set(line.itemId, lineId);
  }
  const approvalRows = revision ? await db.select().from(approvals).where(eq(approvals.revisionId, revision.id)) : [];
  const byLine = new Map(approvalRows.map((approval) => [approval.revisionLineId, approval]));
  const withdrawn = new Map((await db.select().from(openingWithdrawals).where(eq(openingWithdrawals.caseId, row.id))).map((entry) => [entry.itemId, entry]));
  const questionRows = await db.select({ itemId: chatMessages.aboutItemId, count: sql<number>`count(*)::int` }).from(chatMessages)
    .where(and(eq(chatMessages.caseId, row.id), isNotNull(chatMessages.aboutItemId))).groupBy(chatMessages.aboutItemId);
  const questions = new Map(questionRows.map((entry) => [entry.itemId, entry.count]));

  const decisions = new Map<string, ApprovalRow>();
  const lines: Record<string, OpeningLine> = {};
  for (const line of document.lines) {
    const asked = questions.get(line.itemId) ?? 0;
    const decision = lineIds.has(line.itemId) ? byLine.get(lineIds.get(line.itemId)!) : undefined;
    const drop = withdrawn.get(line.itemId);
    if (decision) decisions.set(line.itemId, decision);
    lines[line.itemId] = drop
      ? { state: "withdrawn", note: decision?.note ?? null, decidedAt: drop.withdrawnAt.toISOString(), by: drop.withdrawnBy, questions: asked }
      : decision
        ? { state: decision.decision === "approved" ? "approved" : "declined", note: decision.note, decidedAt: decision.decidedAt.toISOString(), by: decision.approverName, questions: asked }
        : pendingLine(asked);
  }
  const signedAt = approvalRows.filter((approval) => approval.signingId).map((approval) => approval.decidedAt.getTime()).sort((a, b) => b - a)[0];
  return {
    document, lines, approval: null, lineIds, decisions,
    revision: revision ? { id: revision.id, status: revision.status, contentHash: revision.contentHash! } : null,
    opening: openingSummary(document, lines, {
      messageId: sent.messageId, sentAt: sent.sentAt.toISOString(), sentBy: sent.sentBy, contentHash: sent.contentHash,
      closed: !!revision && revision.status !== "sent", signedAt: signedAt ? new Date(signedAt).toISOString() : null,
    }, false),
  };
}

/**
 * The approved part of a V1 signed line by line, as the baseline for payments
 * and changes. Each line carries the client's own signed decision. Null until
 * the client approves a line.
 */
export function approvedBaseline(read: OpeningRead): ApprovedQuoteReport | null {
  const approved = read.document.lines.flatMap((line) => {
    const decision = read.decisions.get(line.itemId);
    if (read.lines[line.itemId].state !== "approved" || !decision) return [];
    return [{ ...line, approval: { status: "approved" as const, approvedBy: decision.approverName, approvedAt: decision.decidedAt.toISOString(), signature: decision.signature, isDemo: true as const } }];
  });
  if (!approved.length) return null;
  const latest = approved.reduce((last, line) => line.approval.approvedAt > last.approval.approvedAt ? line : last);
  return { ...read.document, status: "approved", approvedAt: latest.approval.approvedAt, approvedBy: latest.approval.approvedBy, signature: latest.approval.signature, lines: approved };
}
