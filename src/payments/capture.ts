/**
 * Capture executor. A capture is first written down as an operation, then
 * PayPal is called outside any database transaction, then the result is
 * written back. Retrying an operation reuses its request id, so PayPal returns
 * the original capture instead of taking the money twice.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations, paypalCaptures } from "../db/schema";
import type { CaptureReceipt, PayPalPayments } from "./paypal";

export type PaymentOperation = typeof paymentOperations.$inferSelect;

/** Writes down a capture to be made. Nothing is sent to PayPal yet. */
export async function requestCapture(
  db: Db,
  input: { projectId: string; authorizationId: string; amountCents: number; finalCapture?: boolean },
): Promise<PaymentOperation> {
  const id = randomUUID();
  const [operation] = await db
    .insert(paymentOperations)
    .values({
      id,
      projectId: input.projectId,
      kind: "capture",
      authorizationId: input.authorizationId,
      amountCents: input.amountCents,
      finalCapture: input.finalCapture ?? false,
      requestId: `setti-op-${id}`,
    })
    .returning();
  return operation;
}

/**
 * Runs a capture operation once. Finished operations (succeeded or failed) are
 * returned as they are, without calling PayPal again.
 */
export async function executeCapture(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await db.transaction(async (tx) => {
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for("update");
    if (!operation) throw new Error(`Payment operation ${operationId} does not exist`);
    if (operation.kind !== "capture") throw new Error(`Payment operation ${operationId} is a ${operation.kind}, not a capture`);
    if (operation.status === "succeeded" || operation.status === "failed") return { operation, finished: true as const };

    const [authorization] = await tx.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, operation.authorizationId!));
    const [counted] = await tx
      .update(paymentOperations)
      .set({ attempts: operation.attempts + 1, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operationId))
      .returning();
    return { operation: counted, authorization, finished: false as const };
  });
  if (claim.finished) return claim.operation;

  const { operation, authorization } = claim;
  const result = await paypal.captureAuthorization({
    paypalAuthorizationId: authorization.paypalAuthorizationId,
    amountCents: operation.amountCents,
    finalCapture: operation.finalCapture,
    requestId: operation.requestId,
  });

  switch (result.kind) {
    case "ok":
      return recordCapture(db, operation, result.value);
    case "rejected":
      return update(db, operation.id, { status: "failed", failureCode: result.code, failureMessage: result.message });
    case "unknown":
      return update(db, operation.id, { status: "unknown", failureCode: null, failureMessage: result.message });
    case "retryable":
      return update(db, operation.id, { status: "pending", failureCode: null, failureMessage: result.message });
  }
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
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
    return update(db, operation.id, {
      status: "unknown",
      paypalResourceId: receipt.paypalCaptureId,
      failureCode: "LOCAL_RECORD_REJECTED",
      failureMessage: cause,
    });
  }
}

async function update(db: Db, id: string, fields: Partial<typeof paymentOperations.$inferInsert>): Promise<PaymentOperation> {
  const [operation] = await db
    .update(paymentOperations)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(paymentOperations.id, id))
    .returning();
  return operation;
}
