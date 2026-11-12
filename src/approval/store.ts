import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals, itemCancellations, paymentOperations, paypalAuthorizations, paypalCaptures, paypalRefunds, revisionLines, revisions, servicesHoldLines, supplierEvents } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { createChatStore } from "../chat/store";
import { clientSignatureName } from "../opening/types";
import { changeOrders, pricingCases } from "../pricing/schema";
import { changeOrderContentHash, itemMappingKey } from "../pricing/document";
import type { FrozenChangeOrder } from "../pricing/types";
import { quoteTitle } from "../pricing/title";
import { buildFundingPlan, type FundingFacts, type FundingLineFact } from "./funding";
import { changeOrderDecisions } from "./schema";
import { changeOrderView } from "./view";
import type { ApprovalWorkspace, DecideChangeOrderInput } from "./types";
import { paymentPreparationPending, PREPARATION_MESSAGE } from "../try/preparation";

type Reader = Pick<Db, "select">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApprovalStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApprovalStoreError"; }
}

export interface ProjectLedger {
  authorizations: (typeof paypalAuthorizations.$inferSelect)[];
  captures: (typeof paypalCaptures.$inferSelect)[];
  refunds: (typeof paypalRefunds.$inferSelect)[];
  operations: (typeof paymentOperations.$inferSelect)[];
  supplierEvents: (typeof supplierEvents.$inferSelect)[];
  /** How each design-services hold is split across the services it pays for. */
  servicesHoldLines: (typeof servicesHoldLines.$inferSelect)[];
  /** Items the studio cancelled before they were charged: no version funds them again. */
  cancellations: (typeof itemCancellations.$inferSelect)[];
}

/** Every money record and operation of one business project. */
export async function readLedger(db: Reader, projectId: string): Promise<ProjectLedger> {
  const authorizations = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.projectId, projectId));
  const captures = await db.select().from(paypalCaptures).where(eq(paypalCaptures.projectId, projectId));
  const refunds = (await db.select({ refund: paypalRefunds }).from(paypalRefunds)
    .innerJoin(paypalCaptures, eq(paypalRefunds.captureId, paypalCaptures.id)).where(eq(paypalCaptures.projectId, projectId))).map(({ refund }) => refund);
  const operations = await db.select().from(paymentOperations).where(eq(paymentOperations.projectId, projectId));
  const events = await db.select().from(supplierEvents).where(eq(supplierEvents.projectId, projectId));
  const split = (await db.select({ line: servicesHoldLines }).from(servicesHoldLines)
    .innerJoin(paymentOperations, eq(servicesHoldLines.operationId, paymentOperations.id)).where(eq(paymentOperations.projectId, projectId))).map(({ line }) => line);
  const cancellations = await db.select().from(itemCancellations).where(eq(itemCancellations.projectId, projectId));
  return { authorizations, captures, refunds, operations, supplierEvents: events, servicesHoldLines: split, cancellations };
}

export interface FundingIdentity { itemId: string; side: "baseline" | "proposed" }

/**
 * The business item behind each funding group of a frozen document. A
 * replacement keeps the quote's item id but is a different business item, so
 * its money is never counted as the old product's (and the other way round).
 */
export function fundingIdentities(document: FrozenChangeOrder, itemMapping: Record<string, string>) {
  const byBusiness = new Map<string, FundingIdentity>();
  const blockers: string[] = [];
  for (const line of document.baselineLines) {
    const businessId = itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    if (!businessId) { blockers.push(`The baseline funding identity for ${line.name} is missing.`); continue; }
    if (byBusiness.has(businessId)) blockers.push("A business payment identity maps to more than one baseline item.");
    byBusiness.set(businessId, { itemId: line.itemId, side: "baseline" });
  }
  for (const line of document.lines) {
    const businessId = itemMapping[itemMappingKey(line)];
    if (!businessId) { blockers.push(`The proposed funding identity for ${line.name} is missing.`); continue; }
    const existing = byBusiness.get(businessId);
    if (existing && existing.itemId !== line.itemId) blockers.push("A business payment identity maps to different quote items.");
    if (!existing) byBusiness.set(businessId, { itemId: line.itemId, side: "proposed" });
  }
  const byGroup = new Map([...byBusiness].map(([businessId, identity]) => [`${identity.side}:${identity.itemId}`, businessId]));
  return { byBusiness, byGroup, blockers };
}

/** Read settled ledger facts, never infer payments from quote or approval totals. */
export async function fundingFacts(db: Reader, document: FrozenChangeOrder, caseId: string): Promise<FundingFacts> {
  const [bridge] = await db.select().from(pricingCases).where(eq(pricingCases.caseId, caseId));
  if (!bridge) return { status: "no_records", checkedAt: new Date().toISOString(), lines: [], blockers: ["The business project for this document is unavailable."] };
  return fundingFactsFrom(document, bridge.itemMapping, await readLedger(db, bridge.projectId));
}

export function fundingFactsFrom(document: FrozenChangeOrder, itemMapping: Record<string, string>, ledger: ProjectLedger, now = new Date()): FundingFacts {
  const mapped = fundingIdentities(document, itemMapping);
  return ledgerFacts(mapped.byBusiness, mapped.blockers, ledger, document.id, now);
}

/**
 * Settled ledger facts for the business items of one document (or V1), keyed by
 * their funding identity. Supplier credits count only when recorded for `creditOrderId`.
 */
export function ledgerFacts(identities: ReadonlyMap<string, FundingIdentity>, identityBlockers: readonly string[], ledger: ProjectLedger, creditOrderId: string | null, now = new Date()): FundingFacts {
  const checkedAt = now.toISOString();
  const { authorizations, captures, operations } = ledger;
  const refunds = ledger.refunds.map((refund) => ({ refund }));
  const blockers: string[] = [];
  if (operations.some((operation) => operation.status === "pending" || operation.status === "unknown")) blockers.push("A payment operation is pending or has an unknown outcome. Reconcile it before preparing executable amounts.");
  if (captures.some((capture) => capture.status === "pending")) blockers.push("A capture is pending. Its outcome must be reconciled before calculating settled funds.");
  if (refunds.some(({ refund }) => refund.status === "pending")) blockers.push("A refund is pending. Do not promise another refund or charge until it is reconciled.");
  blockers.push(...identityBlockers);

  const facts = new Map<string, FundingLineFact>();
  const authorizationIds = new Set(authorizations.map((authorization) => authorization.id));
  if (captures.some((capture) => capture.authorizationId && !authorizationIds.has(capture.authorizationId) && capture.status !== "declined")) blockers.push("A capture references an authorization outside this project's ledger. Reconcile that allocation before planning.");
  for (const authorization of authorizations) {
    const settled = captures.filter((capture) => capture.authorizationId === authorization.id && capture.status === "completed");
    const capturedCents = settled.reduce((total, capture) => total + capture.amountCents, 0);
    if (["captured", "partially_captured"].includes(authorization.status) && !captures.some((capture) => capture.authorizationId === authorization.id && capture.status !== "declined")) blockers.push("An authorization reports a capture but its capture records are missing. Reconcile the ledger before planning.");
    const capturedIds = new Set(settled.map((capture) => capture.id));
    const refundedCents = refunds.filter(({ refund }) => capturedIds.has(refund.captureId) && refund.status === "completed").reduce((total, { refund }) => total + refund.amountCents, 0);
    const closed = ["voided", "expired", "captured"].includes(authorization.status) || settled.some((capture) => capture.finalCapture)
      || !!(authorization.expiresAt && authorization.expiresAt.getTime() <= now.getTime());
    if (!authorization.itemId) {
      // The design-services hold: each service's share counts as that service's money.
      const split = ledger.servicesHoldLines.filter((line) => line.operationId === authorization.operationId);
      if (!split.length) {
        if ((closed ? 0 : authorization.amountCents - capturedCents) > 0 || capturedCents > refundedCents) blockers.push("Some project funds are not assigned to an item in this frozen quote. Allocate them before calculating payment actions.");
        continue;
      }
      for (const line of split) {
        const paid = settled.filter((capture) => capture.itemId === line.itemId);
        const paidIds = new Set(paid.map((capture) => capture.id));
        const share = { capturedCents: paid.reduce((total, capture) => total + capture.amountCents, 0), refundedCents: refunds.filter(({ refund }) => paidIds.has(refund.captureId) && refund.status === "completed").reduce((total, { refund }) => total + refund.amountCents, 0) };
        const shareHeld = closed ? 0 : Math.max(0, line.amountCents - share.capturedCents);
        const identity = identities.get(line.itemId);
        if (!identity) {
          if (shareHeld || share.capturedCents > share.refundedCents) blockers.push("Some project funds are not assigned to an item in this frozen quote. Allocate them before calculating payment actions.");
          continue;
        }
        const key = `${identity.side}:${identity.itemId}`;
        const fact = facts.get(key) ?? { ...identity, heldCents: 0, capturedCents: 0, refundedCents: 0 };
        fact.heldCents += shareHeld; fact.capturedCents += share.capturedCents; fact.refundedCents += share.refundedCents;
        facts.set(key, fact);
      }
      continue;
    }
    const heldCents = closed ? 0 : Math.max(0, authorization.amountCents - capturedCents);
    const identity = identities.get(authorization.itemId);
    if (!identity) {
      if (heldCents || capturedCents > refundedCents) blockers.push("Some project funds are not assigned to an item in this frozen quote. Allocate them before calculating payment actions.");
      continue;
    }
    const key = `${identity.side}:${identity.itemId}`;
    const credited = ledger.supplierEvents.some((event) => event.kind === "credit_confirmed" && event.changeOrderId === creditOrderId && event.itemId === authorization.itemId);
    const fact = facts.get(key) ?? { ...identity, heldCents: 0, capturedCents: 0, refundedCents: 0, ...(credited ? { vendorCreditConfirmed: true } : {}) };
    fact.heldCents += heldCents; fact.capturedCents += capturedCents; fact.refundedCents += refundedCents;
    if (authorization.reauthorizedFromId && authorizations.some((old) => old.id === authorization.reauthorizedFromId && ["created", "partially_captured"].includes(old.status))) {
      fact.uncertainReason = "A reauthorization chain still has an open original hold. Reconcile the provider state before using it.";
    }
    facts.set(key, fact);
  }
  if (captures.some((capture) => !capture.authorizationId && capture.status !== "declined")) blockers.push("A direct capture has no item allocation in the current ledger. Allocate it before calculating payment actions.");
  for (const cancellation of ledger.cancellations) {
    const identity = identities.get(cancellation.itemId);
    if (!identity) continue;
    const key = `${identity.side}:${identity.itemId}`;
    facts.set(key, { ...(facts.get(key) ?? { ...identity, heldCents: 0, capturedCents: 0, refundedCents: 0 }), cancelled: true });
  }
  return { status: authorizations.length || captures.length || refunds.length || operations.length || ledger.cancellations.length ? "recorded" : "no_records", checkedAt, lines: [...facts.values()], blockers: [...new Set(blockers)] };
}

export function createApprovalStore(db: Db) {
  async function recoverExpiredLease(sessionId: string | null, id: string) {
    if (!sessionId || !UUID.test(id)) return;
    const [row] = await db.select({ key: chatCases.projectKey, startedAt: chatCases.activeRunStartedAt }).from(changeOrders)
      .innerJoin(chatCases, eq(changeOrders.caseId, chatCases.id)).where(and(eq(changeOrders.id, id), eq(chatCases.sessionId, sessionId)));
    if (row?.startedAt && Date.now() - row.startedAt.getTime() >= 180_000) await createChatStore(db).getCase(sessionId, row.key);
  }

  async function workspace(reader: Reader, sessionId: string | null, id: string): Promise<ApprovalWorkspace | null> {
    if (!UUID.test(id)) return null;
    const [found] = await reader.select({ document: changeOrders.document, caseId: changeOrders.caseId, status: revisions.status, sessionId: chatCases.sessionId, activeRunId: chatCases.activeRunId }).from(changeOrders)
      .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).innerJoin(chatCases, eq(changeOrders.caseId, chatCases.id)).where(eq(changeOrders.id, id));
    if (!found) return null;
    const [decision] = await reader.select().from(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, id));
    const owner = !!sessionId && sessionId === found.sessionId;
    const canDecide = owner && found.status === "sent" && !decision && !found.activeRunId;
    return {
      view: changeOrderView(found.document, found.status, decision), canDecide,
      clientName: owner ? clientSignatureName(found.document) : null,
      reason: !owner ? "This share link is read-only. Sign in as the project's client to confirm it."
        : decision ? "The client's decision has been recorded for this exact version."
          : found.status === "superseded" ? "A newer client version has replaced this document."
            : found.activeRunId ? "Wait for the current AI reply before confirming this version." : null,
      fundingPlan: owner && ((found.status === "sent" && !decision) || (decision?.decision === "approved" && found.status === "approved"))
        ? buildFundingPlan(found.document, await fundingFacts(reader, found.document, found.caseId)) : null,
    };
  }

  return {
    async getWorkspace(sessionId: string | null, id: string) {
      await recoverExpiredLease(sessionId, id);
      return db.transaction((tx) => workspace(tx, sessionId, id), { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async decide(sessionId: string, id: string, input: DecideChangeOrderInput): Promise<ApprovalWorkspace> {
      if (!UUID.test(sessionId) || !UUID.test(id)) throw new ApprovalStoreError("FORBIDDEN", "This demo session cannot confirm this document.");
      await recoverExpiredLease(sessionId, id);
      if (!["approved", "changes_requested"].includes(input.decision) || input.acknowledged !== true || typeof input.signature !== "string" || typeof input.note !== "string" || input.signature.trim().length > 160 || input.note.trim().length > 3000) throw new ApprovalStoreError("INVALID_INPUT", "Review the decision, acknowledgement and signed name.");
      return db.transaction(async (tx) => {
        const [scope] = await tx.select({ caseId: changeOrders.caseId }).from(changeOrders).where(eq(changeOrders.id, id));
        if (!scope) throw new ApprovalStoreError("NOT_FOUND", "This change order could not be found.");
        const [caseRow] = await tx.select().from(chatCases).where(eq(chatCases.id, scope.caseId)).for("update");
        if (caseRow.sessionId !== sessionId) throw new ApprovalStoreError("FORBIDDEN", "This demo session cannot confirm this document.");
        if (await paymentPreparationPending(tx, sessionId, caseRow.projectKey)) throw new ApprovalStoreError("PREPARATION_PENDING", PREPARATION_MESSAGE);
        const [orderRow] = await tx.select().from(changeOrders).where(eq(changeOrders.id, id));
        const [revision] = await tx.select().from(revisions).where(eq(revisions.id, orderRow.revisionId)).for("update");
        const order = orderRow.document;
        const { contentHash, ...withoutHash } = order;
        if (input.contentHash !== contentHash || orderRow.contentHash !== contentHash || changeOrderContentHash(withoutHash) !== contentHash || input.revisionContentHash !== order.revisionContentHash || revision.contentHash !== order.revisionContentHash) throw new ApprovalStoreError("CONTENT_CHANGED", "The displayed content no longer matches this frozen version. Reload before deciding.");
        const signature = input.signature.trim(), note = input.note.trim();
        // The client signs with her name alone, as on V1; the record keeps that signed name.
        const clientName = clientSignatureName(order);
        if (signature !== clientName || !signature) throw new ApprovalStoreError("INVALID_INPUT", "Type the exact demo client name shown on this document.");
        if (input.decision === "changes_requested" && !note) throw new ApprovalStoreError("INVALID_INPUT", "Describe the changes you want the designer to review.");
        const [existing] = await tx.select().from(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, id));
        if (existing) {
          if (existing.decision !== input.decision || existing.signature !== signature || existing.note !== note) throw new ApprovalStoreError("DECISION_CONFLICT", "A different decision is already recorded for this version.");
          return (await workspace(tx, sessionId, id))!;
        }
        if (caseRow.activeRunId) throw new ApprovalStoreError("CASE_BUSY", "Wait for the current AI reply before confirming this version.");
        const [latest] = await tx.select({ id: revisions.id }).from(revisions).where(eq(revisions.projectId, revision.projectId)).orderBy(desc(revisions.number)).limit(1);
        if (revision.status !== "sent" || latest?.id !== revision.id) throw new ApprovalStoreError("STALE_VERSION", "This version is no longer the latest version awaiting a client decision.");
        const decidedAt = new Date();
        await tx.insert(changeOrderDecisions).values({ orderId: id, revisionId: revision.id, sessionId, decision: input.decision, clientName, signature, note, contentHash, revisionContentHash: order.revisionContentHash, decidedAt });
        const lines = await tx.select().from(revisionLines).where(eq(revisionLines.revisionId, revision.id));
        const decision = input.decision === "approved" ? "approved" : "declined";
        for (const line of lines) await tx.insert(approvals).values({ revisionId: revision.id, revisionLineId: line.id, decision, approverName: clientName, signature, contentHash: order.revisionContentHash, decidedAt });
        await tx.update(revisions).set({ status: decision }).where(eq(revisions.id, revision.id));
        if (input.decision === "approved") {
          await tx.update(revisions).set({ status: "superseded" }).where(and(eq(revisions.projectId, revision.projectId), eq(revisions.status, "approved"), ne(revisions.id, revision.id)));
          await tx.update(chatCases).set({ draft: null, updatedAt: decidedAt }).where(eq(chatCases.id, caseRow.id));
        }
        await tx.insert(chatMessages).values({ caseId: caseRow.id, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text: input.decision === "approved"
          ? `Demo client ${clientName} confirmed ${quoteTitle(order)}. This is now the baseline for future changes. No payment has been executed.${note ? ` Note: ${note}` : ""}`
          : `Demo client ${clientName} requested changes to V${order.version}: ${note}. The previously approved quote remains the baseline. No payment has been executed.` });
        return (await workspace(tx, sessionId, id))!;
      });
    },
  };
}
