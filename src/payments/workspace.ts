/**
 * What the change-order page shows about money for one version: the funding
 * plan, each line's recorded holds, captures and refunds, the next steps the
 * server would allow, and every operation with its PayPal evidence. Everything
 * is read from recorded facts; nothing here calls PayPal.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import type { DemoAccount } from "../accounts/demo";
import { items, revisions } from "../db/schema";
import { buildFundingPlan, REFUND_AFTER_CREDIT, type FundingLine, type FundingPlan } from "../approval/funding";
import { changeOrderDecisions } from "../approval/schema";
import { fundingFactsFrom, fundingIdentities, readLedger, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import { changeOrders, pricingCases } from "../pricing/schema";
import { paypalCalls } from "./schema";
import { summarizeHold } from "./holds";
import { confirmedSupplierTerms } from "./supplier-terms";
import { recordedSettlement } from "./fee-evidence";
import { cancellationView } from "./item-holds-view";
import { activeSavedMethod, savedMethodView, type SavedMethodView } from "./saved-methods";
import type { CaptureView, DemoCheckout, HoldView, OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace, RefundView, SupplierEventView } from "./types";

type Reader = Pick<Db, "select">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function paymentsWorkspace(db: Reader, sessionId: string | null, orderId: string, now = new Date(), account: DemoAccount | null = null, demo: DemoCheckout | null = null): Promise<PaymentsWorkspace | null> {
  if (!UUID.test(orderId)) return null;
  const [found] = await db.select({ document: changeOrders.document, caseId: changeOrders.caseId, status: revisions.status, sessionId: chatCases.sessionId })
    .from(changeOrders).innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).innerJoin(chatCases, eq(changeOrders.caseId, chatCases.id))
    .where(eq(changeOrders.id, orderId));
  if (!found) return null;
  const order = found.document;
  const owner = !!sessionId && sessionId === found.sessionId;
  const member = owner && !!account && (account.role === "designer" || account.projectKey === order.projectKey);
  const [decision] = await db.select({ id: changeOrderDecisions.id }).from(changeOrderDecisions)
    .where(and(eq(changeOrderDecisions.orderId, orderId), eq(changeOrderDecisions.decision, "approved")));
  const [bridge] = await db.select().from(pricingCases).where(eq(pricingCases.caseId, found.caseId));
  const current = !!decision && found.status === "approved";
  const reason = !owner ? "This share link is read-only: this browser does not own the demo case, so it cannot start payment steps. Open the case from the browser that created it."
    : !decision ? "Payment steps start only after the client confirms this exact version."
      : !current ? `A newer client-confirmed version replaced V${order.version}. Start payment steps from the current version; results of steps already started stay recorded here.`
        : null;
  const base = { projectKey: order.projectKey, orderId, version: order.version, current, canAct: owner && current, canReconcile: owner && !!decision, reason, environment: "sandbox" as const };
  if (!bridge || !decision) return { ...base, plan: null, lines: [], others: { lineCount: order.lines.length, targetCents: order.totals.totalCents }, operations: [], savedMethod: null, canRemoveSaved: false, checkout: null };

  const ledger = await readLedger(db, bridge.projectId);
  const operationIds = ledger.operations.map((operation) => operation.id);
  const calls = operationIds.length ? await db.select().from(paypalCalls).where(inArray(paypalCalls.operationId, operationIds)).orderBy(desc(paypalCalls.createdAt)) : [];
  const plan = buildFundingPlan(order, fundingFactsFrom(order, bridge.itemMapping, ledger, now));
  const { byGroup } = fundingIdentities(order, bridge.itemMapping);
  const versions = new Map((await db.select({ id: changeOrders.id, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.caseId, found.caseId)))
    .map((row) => [row.id, row.document.version]));
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.projectId, bridge.projectId))).map((row) => [row.id, row.name]));
  const savedMethod = savedMethodView(await activeSavedMethod(db, bridge.projectId));
  const client = member && account?.role === "client";

  const lines: PaymentLineView[] = [];
  const others = { lineCount: 0, targetCents: 0 };
  for (const line of plan.lines) {
    const businessId = byGroup.get(`${line.side}:${line.itemId}`);
    const money = businessId ? itemMoney(ledger, businessId, versions, now, calls) : { holds: [], captures: [], refunds: [] };
    const inScope = line.changed || line.heldCents > 0 || line.capturedCents > 0 || line.refundedCents > 0 || money.holds.length > 0 || money.captures.length > 0;
    if (!inScope) { others.lineCount += 1; others.targetCents += line.targetCents; continue; }
    const events: SupplierEventView[] = ledger.supplierEvents.filter((event) => event.changeOrderId === orderId && event.itemId === businessId)
      .map((event) => ({ id: event.id, kind: event.kind, quantity: event.quantity, unitPriceCents: event.unitPriceCents, taxCents: event.taxCents, freightCents: event.freightCents, totalCents: event.totalCents, inStock: event.inStock, leadTimeDays: event.leadTimeDays, reference: event.reference, note: event.note, isDemo: true, createdAt: event.createdAt.toISOString() }));
    const terms = confirmedSupplierTerms(order, line);
    const kept = line.side === "baseline" ? order.changes.find((change) => change.itemId === line.itemId && change.oldItemHandling !== "not_applicable" && change.oldItemCostCents > 0) : undefined;
    const cancelled = businessId ? ledger.cancellations.find((entry) => entry.itemId === businessId) : undefined;
    // The designer may cancel a furniture item of the current version that nothing was charged for, once its PayPal steps are settled.
    const canCancelItem = owner && current && account?.role === "designer" && !!businessId && !cancelled && line.category === "furniture" && line.targetCents > 0
      && !money.captures.some((capture) => capture.status !== "declined")
      && !ledger.operations.some((operation) => operation.itemId === businessId && (operation.status === "pending" || operation.status === "unknown"));
    lines.push({
      ...line, businessItemId: businessId ?? null, releasedCents: money.holds.reduce((total, hold) => total + hold.releasedCents, 0), ...money,
      confirmedTerms: terms,
      refundRequiresSupplierCredit: line.side === "baseline" && order.changes.some((change) => change.itemId === line.itemId && REFUND_AFTER_CREDIT.includes(change.oldItemHandling)),
      nonRefundable: kept ? { oldItemCostCents: kept.oldItemCostCents, oldItemFees: kept.oldItemFees ?? [] } : null,
      supplierEvents: events, steps: steps(plan, line, owner && current, events, terms?.purpose === "retained_cost", savedMethod).map((step) => ({ ...step, available: step.available && member && step.actor === account?.role })),
      cancellation: cancelled ? cancellationView(cancelled) : null, canCancelItem,
    });
  }
  return {
    ...base, plan, lines, others, operations: await operationViews(db, ledger, versions, names, member, account),
    savedMethod, canRemoveSaved: client && !!savedMethod,
    checkout: client && current && demo ? { ...demo, canSave: !savedMethod } : null,
  };
}

function itemMoney(ledger: ProjectLedger, businessId: string, versions: Map<string, number>, now: Date, calls: (typeof paypalCalls.$inferSelect)[]): { holds: HoldView[]; captures: CaptureView[]; refunds: RefundView[] } {
  const holds = ledger.authorizations.filter((auth) => auth.itemId === businessId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const holdIds = new Set(holds.map((hold) => hold.id));
  // Captures from the item's own holds, and its share of the design-services hold.
  const captures = ledger.captures.filter((capture) => capture.itemId === businessId || (capture.authorizationId && holdIds.has(capture.authorizationId))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const refunds = ledger.refunds.filter((refund) => captures.some((capture) => capture.id === refund.captureId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    holds: holds.map((hold) => {
      const onHold = captures.filter((capture) => capture.authorizationId === hold.id && capture.status !== "declined");
      const completed = onHold.filter((capture) => capture.status === "completed").reduce((total, capture) => total + capture.amountCents, 0);
      const pending = onHold.filter((capture) => capture.status === "pending").reduce((total, capture) => total + capture.amountCents, 0);
      const closed = ["voided", "expired", "captured"].includes(hold.status) || onHold.some((capture) => capture.status === "completed" && capture.finalCapture) || !!(hold.expiresAt && hold.expiresAt.getTime() <= now.getTime());
      const summary = summarizeHold({ authorizedCents: hold.amountCents, capturedCents: completed, pendingCaptureCents: pending, closed });
      return {
        id: hold.id, paypalOrderId: hold.paypalOrderId, paypalAuthorizationId: hold.paypalAuthorizationId, amountCents: hold.amountCents, status: hold.status,
        capturedCents: summary.capturedCents, heldCents: summary.heldCents, releasedCents: summary.releasedCents,
        version: hold.changeOrderId ? versions.get(hold.changeOrderId) ?? null : null,
        createdAt: hold.createdAt.toISOString(), honorExpiresAt: hold.honorExpiresAt?.toISOString() ?? null, expiresAt: hold.expiresAt?.toISOString() ?? null,
      };
    }),
    captures: captures.map((capture) => {
      const of = refunds.filter((refund) => refund.captureId === capture.id);
      return {
        id: capture.id, paypalCaptureId: capture.paypalCaptureId, authorizationId: capture.authorizationId, amountCents: capture.amountCents, status: capture.status,
        finalCapture: capture.finalCapture, operationId: capture.operationId, createdAt: capture.createdAt.toISOString(),
        refundedCents: of.filter((refund) => refund.status === "completed").reduce((total, refund) => total + refund.amountCents, 0),
        pendingRefundCents: of.filter((refund) => refund.status === "pending").reduce((total, refund) => total + refund.amountCents, 0),
        settlement: recordedSettlement("capture", capture.paypalCaptureId, capture.amountCents, calls),
      };
    }),
    refunds: refunds.map((refund) => ({ id: refund.id, paypalRefundId: refund.paypalRefundId, captureId: refund.captureId, amountCents: refund.amountCents, status: refund.status, operationId: refund.operationId, createdAt: refund.createdAt.toISOString(), settlement: recordedSettlement("refund", refund.paypalRefundId, refund.amountCents, calls) })),
  };
}

/** The steps the plan calls for on this line, and whether each can start now. */
function steps(plan: FundingPlan, line: FundingLine, canAct: boolean, events: SupplierEventView[], retainedCost: boolean, saved: SavedMethodView | null): PaymentStep[] {
  const ready = canAct && plan.status !== "blocked";
  const ordered = events.some((event) => event.kind === "order_confirmed");
  const step = (kind: PaymentStep["kind"], amountCents: number, available: boolean, note: string, actor: PaymentStep["actor"] = "designer"): PaymentStep => ({ kind, actor, amountCents, available, note });
  return plan.actions.filter((action) => action.itemId === line.itemId && action.side === line.side).flatMap((action): PaymentStep[] => {
    switch (action.kind) {
      case "new_authorization":
        // With a payment method saved for the project, the hold needs no PayPal window.
        return [step("authorize", action.amountCents, ready && line.category === "furniture", saved
          ? `Held with the client's saved ${saved.kind === "card" ? saved.label : `PayPal (${saved.label})`} without leaving Setti. Nothing is charged until the supplier confirms the order.`
          : "The client approves this hold with PayPal or a card (Sandbox). Nothing is charged until the supplier confirms the order.", "client")];
      case "capture":
        if (action.timing !== "after_vendor_confirmation") {
          const designService = line.category === "service" && (line.change === null || line.change === "add" || line.change === "quantity");
          return [step("capture", action.amountCents, false, designService ? "Design services are paid together in one PayPal checkout, under Design services on this page." : "This charge needs a separate payment step that is not part of this demo.")];
        }
        return ordered
          ? [step("capture", action.amountCents, ready, retainedCost
            ? "The supplier confirmed this version's retained cost. Capture only that cost; closing the hold releases its unused balance."
            : "The supplier confirmation recorded for this version matches the confirmed line. Each PayPal hold is captured separately and closed.")]
          : [
            step("supplier_confirmation", action.amountCents, ready, retainedCost
              ? "Record the supplier's confirmation of the retained cost (demo, entered by the designer). It must match the total cost the client confirmed."
              : "Record the supplier's order confirmation (demo, entered by the designer). Capture becomes available only if the supplier's terms match this version."),
            step("capture", action.amountCents, false, retainedCost ? "Capture runs after the supplier confirms the retained cost." : "Capture runs after the supplier confirms the order."),
          ];
      case "release_authorization":
        return [action.timing === "on_payment_execution"
          ? step("void", action.amountCents, ready, "Release the unused hold. PayPal voids the whole remaining hold; this is a release, not a refund, and nothing is charged.")
          : step("void", action.amountCents, false, "The excess is released when the remaining amount is captured and the hold closes.")];
      case "refund":
        return action.timing === "after_vendor_credit"
          ? [
            step("supplier_credit", action.amountCents, ready, "Record the supplier's credit for the return (demo, entered by the designer). The refund becomes available only if the credit equals the confirmed refund."),
            step("refund", action.amountCents, false, "The refund waits for the supplier's credit."),
          ]
          : [step("refund", action.amountCents, ready, "Refund completed captures above the confirmed amount, newest capture first. Non-refundable fees stay charged.")];
    }
  });
}

async function operationViews(db: Reader, ledger: ProjectLedger, versions: Map<string, number>, names: Map<string, string>, member: boolean, account: DemoAccount | null): Promise<OperationView[]> {
  const ids = ledger.operations.map((operation) => operation.id);
  const calls = ids.length ? await db.select().from(paypalCalls).where(inArray(paypalCalls.operationId, ids)).orderBy(desc(paypalCalls.createdAt)) : [];
  return [...ledger.operations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((operation) => ({
    id: operation.id, businessItemId: operation.itemId, kind: operation.kind, status: operation.status, amountCents: operation.amountCents,
    itemLabel: operation.itemId ? names.get(operation.itemId) ?? null : operation.servicesHold ? "Design services" : null,
    version: operation.changeOrderId ? versions.get(operation.changeOrderId) ?? null : null,
    requestId: operation.requestId, attempts: operation.attempts, paypalOrderId: operation.paypalOrderId,
    approvalUrl: member && account?.role === "client" && operation.kind === "authorize" && operation.status === "pending" && !operation.paypalResourceId ? operation.approvalUrl : null,
    canContinue: member && account?.role === "client" && operation.kind === "authorize" && operation.status === "pending" && !operation.paypalResourceId && !!operation.approvalUrl,
    canCheck: member && (operation.kind === "authorize" || account?.role === "designer"),
    canCancel: member && account?.role === "client" && operation.kind === "authorize" && !!operation.approvalUrl && ["pending", "unknown"].includes(operation.status),
    paypalResourceId: operation.paypalResourceId, failureCode: operation.failureCode, failureMessage: operation.failureMessage,
    createdAt: operation.createdAt.toISOString(), updatedAt: operation.updatedAt.toISOString(),
    calls: calls.filter((call) => call.operationId === operation.id).map((call) => ({
      step: call.step, outcome: call.outcome, httpStatus: call.httpStatus, debugId: call.debugId, resourceId: call.resourceId, resourceStatus: call.resourceStatus,
      amountCents: call.amountCents, errorCode: call.errorCode, message: call.message, createdAt: call.createdAt.toISOString(),
    })),
  }));
}
