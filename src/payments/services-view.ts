/**
 * What the design-services payment shows for one project: the agreement it
 * pays for, each approved design service with what PayPal recorded for it, the
 * checkout in progress, and what this viewer may do. Everything is read from
 * recorded facts; nothing here calls PayPal.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items } from "../db/schema";
import { PaymentActionError } from "./binding";
import { recordedSettlement } from "./fee-evidence";
import type { PaymentOperation } from "./operations";
import { activeSavedMethod, savedMethodView, type SavedMethodView } from "./saved-methods";
import { paypalCalls } from "./schema";
import { lockPaymentBasis } from "./services";
import type { CheckoutView, DemoCheckout, RecordedSettlement } from "./types";

export interface ServiceChargeView {
  /** The quote line id. */
  itemId: string;
  label: string;
  targetCents: number;
  capturedCents: number;
  captures: { paypalCaptureId: string; amountCents: number; status: "completed" | "pending" | "declined"; settlement: RecordedSettlement }[];
}

export interface ServicesPaymentView {
  projectKey: CaseKey;
  /** The agreement payments start from: V1 (no change order) or the latest confirmed version. Null when there is none. */
  basis: { version: number; orderId: string | null } | null;
  services: ServiceChargeView[];
  /** Approved design services not yet captured. */
  dueCents: number;
  /** The latest design-services checkout. */
  checkout: { operationId: string; status: PaymentOperation["status"]; paypalOrderId: string | null; approvalUrl: string | null; authorized: boolean; failureMessage: string | null } | null;
  savedPayPal: boolean;
  /** The project's active saved payment method, as the client recognises it. */
  savedMethod: SavedMethodView | null;
  canRemoveSaved: boolean;
  /** How the client can pay, only when this viewer can pay. */
  checkoutOptions: CheckoutView | null;
  /** The client may start (or resume) the PayPal checkout. */
  canPay: boolean;
  /** The design services are held but not all captured yet. */
  canFinish: boolean;
  /** Either participant can reconcile an unresolved checkout without starting another one. */
  canCheck: boolean;
  reason: string | null;
  /** PayPal JS SDK client id, only when this viewer can pay. A client id is public. */
  paypalClientId: string | null;
}

export async function servicesPaymentView(db: Db, sessionId: string | null, key: CaseKey, account: DemoAccount | null, paypalClientId: string | null, demo: Omit<DemoCheckout, "paypalClientId"> = { testCard: false, sandboxBuyer: null }): Promise<ServicesPaymentView> {
  const empty = (reason: string): ServicesPaymentView => ({ projectKey: key, basis: null, services: [], dueCents: 0, checkout: null, savedPayPal: false, savedMethod: null, canRemoveSaved: false, checkoutOptions: null, canPay: false, canFinish: false, canCheck: false, reason, paypalClientId: null });
  if (!sessionId) return empty("Open this project from the browser that owns the demo case.");
  let basis;
  try { basis = await db.transaction((tx) => lockPaymentBasis(tx, sessionId, key)); }
  catch (error) {
    if (error instanceof PaymentActionError) return empty(error.message);
    throw error;
  }
  const { ledger, plan } = basis;
  const kinds = new Map((await db.select({ id: items.id, kind: items.kind }).from(items).where(eq(items.projectId, basis.projectId))).map((row) => [row.id, row.kind]));
  const captureIds = ledger.captures.map((capture) => capture.paypalCaptureId);
  const calls = captureIds.length ? await db.select().from(paypalCalls).where(inArray(paypalCalls.resourceId, captureIds)).orderBy(desc(paypalCalls.createdAt)) : [];
  const services = plan.lines.flatMap((line): ServiceChargeView[] => {
    const businessId = basis.businessItem(line);
    if (!businessId || kinds.get(businessId) !== "service" || !(line.change === null || line.change === "add" || line.change === "quantity")) return [];
    const captures = ledger.captures.filter((capture) => capture.itemId === businessId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((capture) => ({ paypalCaptureId: capture.paypalCaptureId, amountCents: capture.amountCents, status: capture.status, settlement: recordedSettlement("capture", capture.paypalCaptureId, capture.amountCents, calls) }));
    return [{ itemId: line.itemId, label: line.label, targetCents: line.targetCents, capturedCents: line.capturedCents - line.refundedCents, captures }];
  });
  const dueCents = services.reduce((total, line) => total + Math.max(line.targetCents - line.capturedCents, 0), 0);

  const latest = ledger.operations.filter((operation) => operation.servicesHold).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const hold = latest?.status === "succeeded" ? ledger.authorizations.find((entry) => entry.operationId === latest.id) : undefined;
  const capturedFromHold = hold ? ledger.captures.filter((capture) => capture.authorizationId === hold.id && capture.status !== "declined").reduce((total, capture) => total + capture.amountCents, 0) : 0;
  const participant = !!account && canOpenProject(account, key);
  const pendingCapture = !!hold && ledger.captures.some((capture) => capture.authorizationId === hold.id && capture.status === "pending");
  const canFinish = participant && !!hold && (hold.status === "created" || hold.status === "partially_captured") && capturedFromHold < hold.amountCents;
  const saved = savedMethodView(await activeSavedMethod(db, basis.projectId));

  const client = account?.role === "client" && account.projectKey === key;
  const canCheck = participant && !!latest && (latest.status === "pending" || latest.status === "unknown" || pendingCapture);
  const awaitingHold = latest?.status === "pending" && !!latest.paypalResourceId;
  const canPay = client && dueCents > 0 && !canFinish && latest?.status !== "unknown" && !awaitingHold && !pendingCapture;
  const reason = !services.length ? "The client has not approved a design service yet. Payment starts with the approved design services."
    : dueCents === 0 ? null
      : canFinish ? null
        : pendingCapture ? "PayPal is processing a service capture. Check this same payment before paying again."
        : latest?.status === "unknown" ? "PayPal has not confirmed the last checkout. Check it before paying again."
          : awaitingHold ? "PayPal is reviewing the authorization. Check this same payment for its confirmed outcome."
          : !client ? "The client pays from their own account. Switch to the client's account to pay."
            : null;
  return {
    projectKey: key, basis: { version: basis.version, orderId: basis.orderId }, services, dueCents,
    checkout: latest ? { operationId: latest.id, status: latest.status, paypalOrderId: latest.paypalOrderId, approvalUrl: client && latest.status === "pending" && !latest.paypalResourceId ? latest.approvalUrl : null, authorized: latest.status === "succeeded", failureMessage: latest.failureMessage } : null,
    savedPayPal: !!saved, savedMethod: saved, canRemoveSaved: client && !!saved,
    checkoutOptions: canPay ? { paypalClientId, ...demo, canSave: !saved } : null,
    canPay, canFinish, canCheck, reason, paypalClientId: canPay ? paypalClientId : null,
  };
}
