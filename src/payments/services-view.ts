/**
 * What the design-services payment shows for one project: the agreement it
 * pays for, each approved design service with what PayPal recorded for it, the
 * checkout in progress, and what this viewer may do. Everything is read from
 * recorded facts; nothing here calls PayPal.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { DemoAccount } from "../accounts/demo";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, savedPaymentMethods } from "../db/schema";
import { PaymentActionError } from "./binding";
import { recordedSettlement } from "./fee-evidence";
import type { PaymentOperation } from "./operations";
import { paypalCalls } from "./schema";
import { lockPaymentBasis } from "./services";
import type { RecordedSettlement } from "./types";

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
  checkout: { operationId: string; status: PaymentOperation["status"]; paypalOrderId: string | null; authorized: boolean; failureMessage: string | null } | null;
  savedPayPal: boolean;
  /** The client may start (or resume) the PayPal checkout. */
  canPay: boolean;
  /** The design services are held but not all captured yet. */
  canFinish: boolean;
  reason: string | null;
  /** PayPal JS SDK client id, only when this viewer can pay. A client id is public. */
  paypalClientId: string | null;
}

export async function servicesPaymentView(db: Db, sessionId: string | null, key: CaseKey, account: DemoAccount | null, paypalClientId: string | null): Promise<ServicesPaymentView> {
  const empty = (reason: string): ServicesPaymentView => ({ projectKey: key, basis: null, services: [], dueCents: 0, checkout: null, savedPayPal: false, canPay: false, canFinish: false, reason, paypalClientId: null });
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
  const canFinish = !!hold && (hold.status === "created" || hold.status === "partially_captured") && capturedFromHold < hold.amountCents;
  const [saved] = await db.select({ id: savedPaymentMethods.id }).from(savedPaymentMethods).where(eq(savedPaymentMethods.projectId, basis.projectId));

  const client = account?.role === "client" && account.projectKey === key;
  const canPay = client && dueCents > 0 && !canFinish && latest?.status !== "unknown";
  const reason = !services.length ? "The client has not approved a design service yet. Payment starts with the approved design services."
    : dueCents === 0 ? null
      : canFinish ? null
        : latest?.status === "unknown" ? "PayPal has not confirmed the last checkout. Check it before paying again."
          : !client ? "The client pays from their own account. Switch to the client's account to pay."
            : null;
  return {
    projectKey: key, basis: { version: basis.version, orderId: basis.orderId }, services, dueCents,
    checkout: latest ? { operationId: latest.id, status: latest.status, paypalOrderId: latest.paypalOrderId, authorized: latest.status === "succeeded", failureMessage: latest.failureMessage } : null,
    savedPayPal: !!saved, canPay, canFinish, reason, paypalClientId: canPay ? paypalClientId : null,
  };
}
