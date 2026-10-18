/**
 * Capture executor. A capture is first written down as an operation, then
 * PayPal is called outside any database transaction, then the result is
 * written back. Retrying an operation reuses its request id, so PayPal returns
 * the original capture instead of taking the money twice.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalCaptures } from "../db/schema";
import { claimOperation, databaseMessage, newOperationIds, recordFailure, updateOperation, type PaymentOperation } from "./operations";
import type { CaptureReceipt, PayPalPayments } from "./paypal";

export type { PaymentOperation } from "./operations";

/** Writes down a capture to be made. Nothing is sent to PayPal yet. */
export async function requestCapture(
  db: Db,
  input: { projectId: string; authorizationId: string; amountCents: number; finalCapture?: boolean },
): Promise<PaymentOperation> {
  const [operation] = await db
    .insert(paymentOperations)
    .values({
      ...newOperationIds(),
      projectId: input.projectId,
      kind: "capture",
      authorizationId: input.authorizationId,
      amountCents: input.amountCents,
      finalCapture: input.finalCapture ?? false,
    })
    .returning();
  return operation;
}

/**
 * Runs a capture operation once. Finished operations (succeeded or failed) are
 * returned as they are, without calling PayPal again.
 */
export async function executeCapture(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "capture");
  if (claim.finished) return claim.operation;

  const { operation, authorization } = claim;
  const result = await paypal.captureAuthorization({
    paypalAuthorizationId: authorization.paypalAuthorizationId,
    amountCents: operation.amountCents,
    finalCapture: operation.finalCapture,
    requestId: operation.requestId,
  });
  return result.kind === "ok" ? recordCapture(db, operation, result.value) : recordFailure(db, operation.id, result);
}

async function recordCapture(db: Db, operation: PaymentOperation, receipt: CaptureReceipt): Promise<PaymentOperation> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: paypalCaptures.id })
        .from(paypalCaptures)
        .where(eq(paypalCaptures.paypalCaptureId, receipt.paypalCaptureId));
      if (!existing) {
        await tx.insert(paypalCaptures).values({
          projectId: operation.projectId,
          authorizationId: operation.authorizationId,
          paypalCaptureId: receipt.paypalCaptureId,
          amountCents: receipt.amountCents,
          finalCapture: operation.finalCapture,
          status: receipt.status,
        });
      }
      const [done] = await tx
        .update(paymentOperations)
        .set({ status: "succeeded", paypalResourceId: receipt.paypalCaptureId, failureCode: null, failureMessage: null, updatedAt: new Date() })
        .where(eq(paymentOperations.id, operation.id))
        .returning();
      return done;
    });
  } catch (error) {
    // PayPal took the money but our records refuse it. Keep PayPal's id so a person can look into it.
    return updateOperation(db, operation.id, {
      status: "unknown",
      paypalResourceId: receipt.paypalCaptureId,
      failureCode: "LOCAL_RECORD_REJECTED",
      failureMessage: databaseMessage(error),
    });
  }
}
