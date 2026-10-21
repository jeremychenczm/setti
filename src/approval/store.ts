import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals, paymentOperations, paypalAuthorizations, paypalCaptures, paypalRefunds, revisionLines, revisions } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { createChatStore } from "../chat/store";
import { changeOrders, pricingCases } from "../pricing/schema";
import { changeOrderContentHash, itemMappingKey } from "../pricing/document";
import type { FrozenChangeOrder } from "../pricing/types";
import { buildFundingPlan, type FundingFacts, type FundingLineFact } from "./funding";
import { changeOrderDecisions } from "./schema";
import { changeOrderView } from "./view";
import type { ApprovalWorkspace, DecideChangeOrderInput } from "./types";

type Reader = Pick<Db, "select">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApprovalStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApprovalStoreError"; }
}

/** Read settled ledger facts, never infer payments from quote or approval totals. */
export async function fundingFacts(db: Reader, document: FrozenChangeOrder, caseId: string): Promise<FundingFacts> {
  const checkedAt = new Date().toISOString();
  const [bridge] = await db.select().from(pricingCases).where(eq(pricingCases.caseId, caseId));
  if (!bridge) return { status: "no_records", checkedAt, lines: [], blockers: ["The business project for this document is unavailable."] };
  const authorizations = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.projectId, bridge.projectId));
  const captures = await db.select().from(paypalCaptures).where(eq(paypalCaptures.projectId, bridge.projectId));
  const refunds = await db.select({ refund: paypalRefunds }).from(paypalRefunds)
    .innerJoin(paypalCaptures, eq(paypalRefunds.captureId, paypalCaptures.id)).where(eq(paypalCaptures.projectId, bridge.projectId));
  const operations = await db.select().from(paymentOperations).where(eq(paymentOperations.projectId, bridge.projectId));
  const blockers: string[] = [];
  if (operations.some((operation) => operation.status === "pending" || operation.status === "unknown")) blockers.push("A payment operation is pending or has an unknown outcome. Reconcile it before preparing executable amounts.");
  if (captures.some((capture) => capture.status === "pending")) blockers.push("A capture is pending. Its outcome must be reconciled before calculating settled funds.");
  if (refunds.some(({ refund }) => refund.status === "pending")) blockers.push("A refund is pending. Do not promise another refund or charge until it is reconciled.");

  const identities = new Map<string, { itemId: string; side: "baseline" | "proposed" }>();
  for (const line of document.baselineLines) {
    const businessId = bridge.itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    if (!businessId) { blockers.push(`The baseline funding identity for ${line.name} is missing.`); continue; }
    if (identities.has(businessId)) blockers.push("A business payment identity maps to more than one baseline item.");
    identities.set(businessId, { itemId: line.itemId, side: "baseline" });
  }
  for (const line of document.lines) {
    const businessId = bridge.itemMapping[itemMappingKey(line)];
    if (!businessId) { blockers.push(`The proposed funding identity for ${line.name} is missing.`); continue; }
    const existing = identities.get(businessId);
    if (existing && existing.itemId !== line.itemId) blockers.push("A business payment identity maps to different quote items.");
    if (!existing) identities.set(businessId, { itemId: line.itemId, side: "proposed" });
  }

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
      || !!(authorization.expiresAt && authorization.expiresAt.getTime() <= Date.now());
    const heldCents = closed ? 0 : Math.max(0, authorization.amountCents - capturedCents);
    const identity = authorization.itemId ? identities.get(authorization.itemId) : undefined;
    if (!identity) {
      if (heldCents || capturedCents > refundedCents) blockers.push("Some project funds are not assigned to an item in this frozen quote. Allocate them before calculating payment actions.");
      continue;
    }
    const key = `${identity.side}:${identity.itemId}`;
    const fact = facts.get(key) ?? { ...identity, heldCents: 0, capturedCents: 0, refundedCents: 0 };
    fact.heldCents += heldCents; fact.capturedCents += capturedCents; fact.refundedCents += refundedCents;
    if (authorization.reauthorizedFromId && authorizations.some((old) => old.id === authorization.reauthorizedFromId && ["created", "partially_captured"].includes(old.status))) {
      fact.uncertainReason = "A reauthorization chain still has an open original hold. Reconcile the provider state before using it.";
    }
    facts.set(key, fact);
  }
  if (captures.some((capture) => !capture.authorizationId && capture.status !== "declined")) blockers.push("A direct capture has no item allocation in the current ledger. Allocate it before calculating payment actions.");
  return { status: authorizations.length || captures.length || refunds.length || operations.length ? "recorded" : "no_records", checkedAt, lines: [...facts.values()], blockers: [...new Set(blockers)] };
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
      clientName: owner ? found.document.clientName : null,
      reason: !owner ? "This share link is read-only. Open it from the browser that owns the demo case to act as its demo client."
        : decision ? "The client's decision has been recorded for this exact version."
          : found.status === "superseded" ? "A newer client version has replaced this document."
            : found.activeRunId ? "Wait for the current AI reply before confirming this version." : null,
      fundingPlan: owner && decision?.decision === "approved" && found.status === "approved" ? buildFundingPlan(found.document, await fundingFacts(reader, found.document, found.caseId)) : null,
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
        const [orderRow] = await tx.select().from(changeOrders).where(eq(changeOrders.id, id));
        const [revision] = await tx.select().from(revisions).where(eq(revisions.id, orderRow.revisionId)).for("update");
        const order = orderRow.document;
        const { contentHash, ...withoutHash } = order;
        if (input.contentHash !== contentHash || orderRow.contentHash !== contentHash || changeOrderContentHash(withoutHash) !== contentHash || input.revisionContentHash !== order.revisionContentHash || revision.contentHash !== order.revisionContentHash) throw new ApprovalStoreError("CONTENT_CHANGED", "The displayed content no longer matches this frozen version. Reload before deciding.");
        const signature = input.signature.trim(), note = input.note.trim();
        if (signature !== order.clientName || !signature) throw new ApprovalStoreError("INVALID_INPUT", "Type the exact demo client name shown on this document.");
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
        await tx.insert(changeOrderDecisions).values({ orderId: id, revisionId: revision.id, sessionId, decision: input.decision, clientName: order.clientName, signature, note, contentHash, revisionContentHash: order.revisionContentHash, decidedAt });
        const lines = await tx.select().from(revisionLines).where(eq(revisionLines.revisionId, revision.id));
        const decision = input.decision === "approved" ? "approved" : "declined";
        for (const line of lines) await tx.insert(approvals).values({ revisionId: revision.id, revisionLineId: line.id, decision, approverName: order.clientName, signature, contentHash: order.revisionContentHash, decidedAt });
        await tx.update(revisions).set({ status: decision }).where(eq(revisions.id, revision.id));
        if (input.decision === "approved") {
          await tx.update(revisions).set({ status: "superseded" }).where(and(eq(revisions.projectId, revision.projectId), eq(revisions.status, "approved"), ne(revisions.id, revision.id)));
          await tx.update(chatCases).set({ draft: null, updatedAt: decidedAt }).where(eq(chatCases.id, caseRow.id));
        }
        await tx.insert(chatMessages).values({ caseId: caseRow.id, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text: input.decision === "approved"
          ? `Demo client ${order.clientName} confirmed V${order.version}: ${order.title}. This is now the baseline for future changes. No payment has been executed.${note ? ` Note: ${note}` : ""}`
          : `Demo client ${order.clientName} requested changes to V${order.version}: ${note}. The previously approved quote remains the baseline. No payment has been executed.` });
        return (await workspace(tx, sessionId, id))!;
      });
    },
  };
}
