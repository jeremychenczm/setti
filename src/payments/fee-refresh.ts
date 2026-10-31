/** Refresh seller amounts of known completed transactions using GET only. */
import type { Db } from "../db/client";
import { fundingIdentities, readLedger } from "../approval/store";
import { lockConfirmedVersion, PaymentActionError } from "./binding";
import { settlementDetails } from "./fees";
import { recordCall } from "./operations";
import type { CaptureReceipt, PayPalPayments, PayPalResult, RefundReceipt } from "./paypal";
import { lockOpeningVersion } from "./opening";
import type { CaseKey } from "../chat/types";

type Resource = { kind: "capture" | "refund"; id: string; operationId: string; amountCents: number };
type FeeReader = Pick<PayPalPayments, "getCapture" | "getRefund">;

/** Read seller amounts for captures that belong to a signed opening V1. */
export async function refreshOpeningRecordedFees(db: Db, paypal: FeeReader, sessionId: string, key: CaseKey): Promise<void> {
  const resources = await db.transaction(async (tx): Promise<Resource[]> => {
    const version = await lockOpeningVersion(tx, sessionId, key, null);
    const ledger = await readLedger(tx, version.projectId);
    const ids = new Set(version.approved.map((entry) => entry.itemId));
    const holds = new Set(ledger.authorizations.filter((hold) => hold.itemId && ids.has(hold.itemId)).map((hold) => hold.id));
    return ledger.captures.flatMap((capture) => capture.authorizationId && holds.has(capture.authorizationId) && capture.status === "completed" && capture.operationId ? [{ kind: "capture" as const, id: capture.paypalCaptureId, operationId: capture.operationId, amountCents: capture.amountCents }] : []);
  });
  for (const resource of resources) await recordFeeObservation(db, resource, await paypal.getCapture(resource.id));
}

export async function refreshRecordedFees(db: Db, paypal: FeeReader, sessionId: string, orderId: string): Promise<void> {
  const resources = await db.transaction(async (tx): Promise<Resource[]> => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, null, false);
    const ledger = await readLedger(tx, version.projectId);
    const businessIds = new Set(fundingIdentities(version.order, version.itemMapping).byBusiness.keys());
    const holds = new Set(ledger.authorizations.filter((hold) => hold.itemId && businessIds.has(hold.itemId)).map((hold) => hold.id));
    const captures = ledger.captures.filter((capture) => capture.authorizationId && holds.has(capture.authorizationId) && capture.status === "completed");
    const captureIds = new Set(captures.map((capture) => capture.id));
    const operations = new Map(ledger.operations.map((operation) => [operation.id, operation]));
    const result: Resource[] = [];
    for (const capture of captures) {
      if (capture.operationId && operations.get(capture.operationId)?.kind === "capture") result.push({ kind: "capture", id: capture.paypalCaptureId, operationId: capture.operationId, amountCents: capture.amountCents });
    }
    for (const refund of ledger.refunds) {
      if (captureIds.has(refund.captureId) && refund.status === "completed" && refund.operationId && operations.get(refund.operationId)?.kind === "refund") result.push({ kind: "refund", id: refund.paypalRefundId, operationId: refund.operationId, amountCents: refund.amountCents });
    }
    if (result.length > 50) throw new PaymentActionError("NOT_AVAILABLE", "This version has more completed transactions than one fee lookup can check.");
    return result;
  });
  // Provider reads happen after releasing the case lock. No operation is created,
  // claimed, retried or settled here; only the original call log is appended.
  for (const resource of resources) {
    const result = resource.kind === "capture" ? await paypal.getCapture(resource.id) : await paypal.getRefund(resource.id);
    await recordFeeObservation(db, resource, result);
  }
}

async function recordFeeObservation(db: Db, resource: Resource, result: PayPalResult<CaptureReceipt | RefundReceipt>) {
  const receipt = result.kind === "ok" ? result.value : null;
  const receivedId = receipt ? ("paypalCaptureId" in receipt ? receipt.paypalCaptureId : (receipt as RefundReceipt).paypalRefundId) : null;
  const statuses = resource.kind === "capture" ? ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] : ["COMPLETED"];
  const mismatch = receipt && (receivedId !== resource.id || receipt.amountCents !== resource.amountCents || receipt.currency !== "USD" || !statuses.includes(receipt.status ?? ""));
  await recordCall(db, resource.operationId, resource.kind === "capture" ? "get_capture" : "get_refund", null, result, {
    resourceId: resource.id, status: receipt?.status, amountCents: receipt?.amountCents, currency: receipt?.currency,
    details: {
      ...(receipt ? settlementDetails(receipt) : {}), settlementRead: true,
      observedResourceId: receivedId,
      ...(mismatch ? { settlementLookupError: "PayPal returned a different identity, amount, currency or transaction state. Fee amounts are not adopted; the saved payment state was not changed." } : {}),
    },
  });
}
