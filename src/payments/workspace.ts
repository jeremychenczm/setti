/**
 * What the change-order page shows about money for one version: the funding
 * plan, each line's recorded holds, captures and refunds, the next steps the
 * server would allow, and every operation with its PayPal evidence. Everything
 * is read from recorded facts; nothing here calls PayPal.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, revisions } from "../db/schema";
import { buildFundingPlan, type FundingLine, type FundingPlan } from "../approval/funding";
import { changeOrderDecisions } from "../approval/schema";
import { fundingFactsFrom, fundingIdentities, readLedger, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import { changeOrders, pricingCases } from "../pricing/schema";
import { paypalCalls } from "./schema";
import type { CaptureView, HoldView, OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace, RefundView } from "./types";

type Reader = Pick<Db, "select">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function paymentsWorkspace(db: Reader, sessionId: string | null, orderId: string, now = new Date()): Promise<PaymentsWorkspace | null> {
  if (!UUID.test(orderId)) return null;
  const [found] = await db.select({ document: changeOrders.document, caseId: changeOrders.caseId, status: revisions.status, sessionId: chatCases.sessionId })
    .from(changeOrders).innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).innerJoin(chatCases, eq(changeOrders.caseId, chatCases.id))
    .where(eq(changeOrders.id, orderId));
  if (!found) return null;
  const order = found.document;
  const owner = !!sessionId && sessionId === found.sessionId;
  const [decision] = await db.select({ id: changeOrderDecisions.id }).from(changeOrderDecisions)
    .where(and(eq(changeOrderDecisions.orderId, orderId), eq(changeOrderDecisions.decision, "approved")));
  const [bridge] = await db.select().from(pricingCases).where(eq(pricingCases.caseId, found.caseId));
  const current = !!decision && found.status === "approved";
  const reason = !owner ? "This share link is read-only. Payment steps run only from the browser that owns the demo case."
    : !decision ? "Payment steps start only after the client confirms this exact version."
      : !current ? `A newer client-confirmed version replaced V${order.version}. Start payment steps from the current version; results of steps already started stay recorded here.`
        : null;
  const base = { orderId, version: order.version, current, canAct: owner && current, reason, environment: "sandbox" as const };
  if (!bridge || !decision) return { ...base, plan: null, lines: [], others: { lineCount: order.lines.length, targetCents: order.totals.totalCents }, operations: [] };

  const ledger = await readLedger(db, bridge.projectId);
  const plan = buildFundingPlan(order, fundingFactsFrom(order, bridge.itemMapping, ledger, now));
  const { byGroup } = fundingIdentities(order, bridge.itemMapping);
  const versions = new Map((await db.select({ id: changeOrders.id, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.caseId, found.caseId)))
    .map((row) => [row.id, row.document.version]));
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.projectId, bridge.projectId))).map((row) => [row.id, row.name]));

  const lines: PaymentLineView[] = [];
  const others = { lineCount: 0, targetCents: 0 };
  for (const line of plan.lines) {
    const businessId = byGroup.get(`${line.side}:${line.itemId}`);
    const money = businessId ? itemMoney(ledger, businessId, versions, now) : { holds: [], captures: [], refunds: [] };
    const inScope = line.changed || line.heldCents > 0 || line.capturedCents > 0 || line.refundedCents > 0 || money.holds.length > 0 || money.captures.length > 0;
    if (!inScope) { others.lineCount += 1; others.targetCents += line.targetCents; continue; }
    lines.push({
      ...line, releasedCents: money.holds.reduce((total, hold) => total + hold.releasedCents, 0),
      ...money, steps: steps(plan, line, owner && current),
    });
  }
  return { ...base, plan, lines, others, operations: await operationViews(db, ledger, versions, names, owner) };
}

function itemMoney(ledger: ProjectLedger, businessId: string, versions: Map<string, number>, now: Date): { holds: HoldView[]; captures: CaptureView[]; refunds: RefundView[] } {
  const holds = ledger.authorizations.filter((auth) => auth.itemId === businessId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const holdIds = new Set(holds.map((hold) => hold.id));
  const captures = ledger.captures.filter((capture) => capture.authorizationId && holdIds.has(capture.authorizationId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const refunds = ledger.refunds.filter((refund) => captures.some((capture) => capture.id === refund.captureId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    holds: holds.map((hold) => {
      const onHold = captures.filter((capture) => capture.authorizationId === hold.id && capture.status !== "declined");
      const completed = onHold.filter((capture) => capture.status === "completed").reduce((total, capture) => total + capture.amountCents, 0);
      const taken = onHold.reduce((total, capture) => total + capture.amountCents, 0);
      const closed = ["voided", "expired", "captured"].includes(hold.status) || onHold.some((capture) => capture.finalCapture) || !!(hold.expiresAt && hold.expiresAt.getTime() <= now.getTime());
      return {
        id: hold.id, paypalOrderId: hold.paypalOrderId, paypalAuthorizationId: hold.paypalAuthorizationId, amountCents: hold.amountCents, status: hold.status,
        capturedCents: completed, heldCents: closed ? 0 : Math.max(hold.amountCents - taken, 0), releasedCents: closed ? Math.max(hold.amountCents - completed, 0) : 0,
        version: hold.changeOrderId ? versions.get(hold.changeOrderId) ?? null : null,
        createdAt: hold.createdAt.toISOString(), honorExpiresAt: hold.honorExpiresAt?.toISOString() ?? null, expiresAt: hold.expiresAt?.toISOString() ?? null,
      };
    }),
    captures: captures.map((capture) => {
      const of = refunds.filter((refund) => refund.captureId === capture.id);
      return {
        id: capture.id, paypalCaptureId: capture.paypalCaptureId, authorizationId: capture.authorizationId, amountCents: capture.amountCents, status: capture.status,
        finalCapture: capture.finalCapture, createdAt: capture.createdAt.toISOString(),
        refundedCents: of.filter((refund) => refund.status === "completed").reduce((total, refund) => total + refund.amountCents, 0),
        pendingRefundCents: of.filter((refund) => refund.status === "pending").reduce((total, refund) => total + refund.amountCents, 0),
      };
    }),
    refunds: refunds.map((refund) => ({ id: refund.id, paypalRefundId: refund.paypalRefundId, captureId: refund.captureId, amountCents: refund.amountCents, status: refund.status, createdAt: refund.createdAt.toISOString() })),
  };
}

/** The steps the plan calls for on this line, and whether each can start now. */
function steps(plan: FundingPlan, line: FundingLine, canAct: boolean): PaymentStep[] {
  const ready = canAct && plan.status !== "blocked";
  return plan.actions.filter((action) => action.itemId === line.itemId && action.side === line.side).map((action): PaymentStep => {
    switch (action.kind) {
      case "new_authorization":
        return { kind: "authorize", actor: "client", amountCents: action.amountCents, available: ready && line.category === "furniture", note: "The client approves this hold on PayPal (Sandbox). Nothing is charged until the supplier confirms the order." };
      case "capture":
        return { kind: "capture", actor: "designer", amountCents: action.amountCents, available: false, note: action.timing === "after_vendor_confirmation" ? "Capture runs after the supplier confirms the order." : "This charge needs a separate payment step that is not part of this demo." };
      case "release_authorization":
        return { kind: "void", actor: "designer", amountCents: action.amountCents, available: false, note: action.timing === "on_payment_execution" ? "Release the unused hold (a void, not a refund)." : "The excess is released when the remaining amount is captured." };
      case "refund":
        return { kind: "refund", actor: "designer", amountCents: action.amountCents, available: false, note: action.timing === "after_vendor_credit" ? "The refund waits for the supplier's credit." : "Refund completed captures above the confirmed amount." };
    }
  });
}

async function operationViews(db: Reader, ledger: ProjectLedger, versions: Map<string, number>, names: Map<string, string>, owner: boolean): Promise<OperationView[]> {
  const ids = ledger.operations.map((operation) => operation.id);
  const calls = ids.length ? await db.select().from(paypalCalls).where(inArray(paypalCalls.operationId, ids)).orderBy(desc(paypalCalls.createdAt)) : [];
  return [...ledger.operations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((operation) => ({
    id: operation.id, kind: operation.kind, status: operation.status, amountCents: operation.amountCents,
    itemLabel: operation.itemId ? names.get(operation.itemId) ?? null : null,
    version: operation.changeOrderId ? versions.get(operation.changeOrderId) ?? null : null,
    requestId: operation.requestId, attempts: operation.attempts, paypalOrderId: operation.paypalOrderId,
    approvalUrl: owner && operation.kind === "authorize" && operation.status === "pending" && !operation.paypalResourceId ? operation.approvalUrl : null,
    paypalResourceId: operation.paypalResourceId, failureCode: operation.failureCode, failureMessage: operation.failureMessage,
    createdAt: operation.createdAt.toISOString(), updatedAt: operation.updatedAt.toISOString(),
    calls: calls.filter((call) => call.operationId === operation.id).map((call) => ({
      step: call.step, outcome: call.outcome, httpStatus: call.httpStatus, debugId: call.debugId, resourceId: call.resourceId, resourceStatus: call.resourceStatus,
      amountCents: call.amountCents, errorCode: call.errorCode, message: call.message, createdAt: call.createdAt.toISOString(),
    })),
  }));
}
