/**
 * Capture executor. A capture is first written down as an operation, then
 * PayPal is called outside any database transaction, then the result is
 * written back. Retrying an operation reuses its request id, so PayPal returns
 * the original capture instead of taking the money twice.
 *
 * The operation succeeds only on a verified receipt (capture id, recognised
 * status, the exact amount in USD). A pending capture is recorded as pending,
 * a declined one fails the operation, and an incomplete or different receipt
 * leaves the operation unknown for reconciliation, never "completed".
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations, paypalCaptures } from "../db/schema";
import {
  claimOperation, databaseMessage, insertOperation, recordCall, recordFailure, updateOperation,
  type OperationBinding, type PaymentOperation, type PaypalAuthorization, type PaypalCapture,
} from "./operations";
import type { CaptureReceipt, PayPalFailure, PayPalPayments, PayPalResult } from "./paypal";
import { captureMoneyStatus, verifyCapture } from "./receipts";

export type { PaymentOperation } from "./operations";

/** Writes down a capture to be made, once per business event. Nothing is sent to PayPal yet. */
export async function requestCapture(
  db: Pick<Db, "select" | "insert" | "update">,
  input: { businessKey: string; projectId: string; authorizationId: string; amountCents: number; finalCapture?: boolean; binding?: OperationBinding },
): Promise<PaymentOperation> {
  return insertOperation(db, { kind: "capture", ...input });
}

/**
 * Runs a capture operation once. Finished operations (succeeded or failed) are
 * returned as they are, without calling PayPal again. An operation that already
 * knows its PayPal capture id is read back instead of sent again.
 */
export async function executeCapture(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "capture");
  if (claim.finished) return claim.operation;

  const { operation } = claim;
  const authorization = claim.authorization!;
  if (operation.paypalResourceId) return readBack(db, paypal, operation, authorization, operation.paypalResourceId);

  const result = await paypal.captureAuthorization({
    paypalAuthorizationId: authorization.paypalAuthorizationId,
    amountCents: operation.amountCents,
    finalCapture: operation.finalCapture,
    requestId: operation.requestId,
  });
  await logCapture(db, operation, "capture", operation.requestId, result);
  return result.kind === "ok" ? settle(db, paypal, operation, authorization, result.value, true) : captureFailed(db, operation, authorization, result);
}

/** Reads a pending capture back from PayPal and records where its money now stands. */
export async function refreshCapture(db: Db, paypal: PayPalPayments, captureId: string): Promise<PaypalCapture> {
  const [capture] = await db.select().from(paypalCaptures).where(eq(paypalCaptures.id, captureId));
  if (!capture) throw new Error(`Capture ${captureId} does not exist`);
  if (capture.status !== "pending" || !capture.operationId) return capture;
  const result = await paypal.getCapture(capture.paypalCaptureId);
  await logCapture(db, { id: capture.operationId }, "get_capture", null, result);
  if (result.kind !== "ok") return capture;
  const verified = verifyCapture(result.value, capture.amountCents);
  if (!verified.ok || verified.value.status === "pending") return capture;
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(paypalCaptures).set({ status: verified.value.status }).where(eq(paypalCaptures.id, capture.id)).returning();
    if (verified.value.status === "completed") await closeHold(tx, capture.authorizationId, capture.finalCapture);
    return updated;
  });
}

async function readBack(db: Db, paypal: PayPalPayments, operation: PaymentOperation, authorization: PaypalAuthorization, paypalCaptureId: string): Promise<PaymentOperation> {
  const result = await paypal.getCapture(paypalCaptureId);
  await logCapture(db, operation, "get_capture", null, result);
  if (result.kind !== "ok") return updateOperation(db, operation.id, { failureMessage: `PayPal capture ${paypalCaptureId} could not be read back: ${result.message}` });
  return settle(db, paypal, operation, authorization, result.value, false);
}

async function settle(db: Db, paypal: PayPalPayments, operation: PaymentOperation, authorization: PaypalAuthorization, receipt: CaptureReceipt, mayReadBack: boolean): Promise<PaymentOperation> {
  let verified = verifyCapture(receipt, operation.amountCents);
  if (!verified.ok && verified.code === "RECEIPT_INCOMPLETE" && receipt.paypalCaptureId && mayReadBack) {
    // Read the capture back once before deciding anything about an incomplete receipt.
    const read = await paypal.getCapture(receipt.paypalCaptureId);
    await logCapture(db, operation, "get_capture", null, read);
    if (read.kind === "ok") {
      receipt = read.value;
      verified = verifyCapture(read.value, operation.amountCents);
    }
  }
  if (!verified.ok) {
    return updateOperation(db, operation.id, {
      status: "unknown", failureCode: verified.code, failureMessage: verified.message,
      ...(receipt.paypalCaptureId ? { paypalResourceId: receipt.paypalCaptureId } : {}),
    });
  }
  const { paypalCaptureId, status } = verified.value;
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: paypalCaptures.id }).from(paypalCaptures).where(eq(paypalCaptures.paypalCaptureId, paypalCaptureId));
      if (!existing) {
        await tx.insert(paypalCaptures).values({
          projectId: operation.projectId, authorizationId: operation.authorizationId, paypalCaptureId,
          amountCents: operation.amountCents, currency: operation.currency, finalCapture: operation.finalCapture, status, operationId: operation.id,
        });
      }
      if (status === "completed") await closeHold(tx, authorization.id, operation.finalCapture);
      const [done] = await tx
        .update(paymentOperations)
        .set(status === "declined"
          ? { status: "failed", paypalResourceId: paypalCaptureId, failureCode: "CAPTURE_DECLINED", failureMessage: "PayPal declined this capture; no money was taken.", updatedAt: new Date() }
          : { status: "succeeded", paypalResourceId: paypalCaptureId, failureCode: null, failureMessage: null, updatedAt: new Date() })
        .where(eq(paymentOperations.id, operation.id))
        .returning();
      return done;
    });
  } catch (error) {
    // PayPal took the money but our records refuse it. Keep PayPal's id so a person can look into it.
    return updateOperation(db, operation.id, {
      status: "unknown",
      paypalResourceId: paypalCaptureId,
      failureCode: "LOCAL_RECORD_REJECTED",
      failureMessage: databaseMessage(error),
    });
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Mirrors PayPal's hold status after completed money: a final capture closes the hold. */
async function closeHold(tx: Tx, authorizationId: string | null, finalCapture: boolean): Promise<void> {
  if (!authorizationId) return;
  const [auth] = await tx.select({ status: paypalAuthorizations.status }).from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId)).for("update");
  const next = finalCapture ? "captured" : "partially_captured";
  if (auth && (auth.status === "created" || (auth.status === "partially_captured" && next === "captured"))) {
    await tx.update(paypalAuthorizations).set({ status: next }).where(eq(paypalAuthorizations.id, authorizationId));
  }
}

/** A refused capture fails; PayPal saying the hold has expired or been voided is recorded on the hold too. */
async function captureFailed(db: Db, operation: PaymentOperation, authorization: PaypalAuthorization, result: PayPalFailure): Promise<PaymentOperation> {
  const code = result.kind === "rejected" ? result.code : null;
  const closed = code === "AUTHORIZATION_EXPIRED" ? "expired" : code === "AUTHORIZATION_VOIDED" ? "voided" : null;
  if (!closed) return recordFailure(db, operation.id, result);
  return db.transaction(async (tx) => {
    const [auth] = await tx.select({ status: paypalAuthorizations.status }).from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorization.id)).for("update");
    if (auth.status === "created" || auth.status === "partially_captured") await tx.update(paypalAuthorizations).set({ status: closed }).where(eq(paypalAuthorizations.id, authorization.id));
    return recordFailure(tx, operation.id, result);
  });
}

function logCapture(db: Db, operation: Pick<PaymentOperation, "id">, step: "capture" | "get_capture", requestId: string | null, result: PayPalResult<CaptureReceipt>) {
  const receipt = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, step, requestId, result, receipt && {
    resourceId: receipt.paypalCaptureId, status: receipt.status, amountCents: receipt.amountCents, currency: receipt.currency,
    details: { finalCapture: receipt.finalCapture, createTime: receipt.createTime, money: captureMoneyStatus(receipt.status) ?? null },
  });
}
