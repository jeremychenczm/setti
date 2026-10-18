/**
 * Shared steps of every money move: write it down, claim it for one attempt,
 * and write the outcome back. PayPal is always called between `claimOperation`
 * and the write-back, outside any database transaction.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations } from "../db/schema";
import type { PayPalResult } from "./paypal";

export type PaymentOperation = typeof paymentOperations.$inferSelect;
export type PaypalAuthorization = typeof paypalAuthorizations.$inferSelect;
type OperationKind = PaymentOperation["kind"];

/** A new operation id and the request id every attempt of it sends to PayPal. */
export function newOperationIds(): { id: string; requestId: string } {
  const id = randomUUID();
  return { id, requestId: `setti-op-${id}` };
}

export type Claim =
  | { finished: true; operation: PaymentOperation }
  | { finished: false; operation: PaymentOperation; authorization: PaypalAuthorization };

/**
 * Locks the operation, returns it untouched if it already succeeded or failed,
 * and otherwise counts one more attempt and loads the hold it acts on.
 */
export async function claimOperation(db: Db, operationId: string, kind: OperationKind): Promise<Claim> {
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for("update");
    if (!operation) throw new Error(`Payment operation ${operationId} does not exist`);
    if (operation.kind !== kind) throw new Error(`Payment operation ${operationId} is a ${operation.kind}, not a ${kind}`);
    if (operation.status === "succeeded" || operation.status === "failed") return { finished: true, operation };

    const [authorization] = await tx.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, operation.authorizationId!));
    const [counted] = await tx
      .update(paymentOperations)
      .set({ attempts: operation.attempts + 1, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operationId))
      .returning();
    return { finished: false, operation: counted, authorization };
  });
}

export async function updateOperation(db: Db, id: string, fields: Partial<typeof paymentOperations.$inferInsert>): Promise<PaymentOperation> {
  const [operation] = await db
    .update(paymentOperations)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(paymentOperations.id, id))
    .returning();
  return operation;
}

/** Writes back a call that did not succeed: rejected fails, unknown waits for a retry, retryable stays pending. */
export function recordFailure(db: Db, id: string, result: Exclude<PayPalResult<unknown>, { kind: "ok" }>): Promise<PaymentOperation> {
  switch (result.kind) {
    case "rejected":
      return updateOperation(db, id, { status: "failed", failureCode: result.code, failureMessage: result.message });
    case "unknown":
      return updateOperation(db, id, { status: "unknown", failureCode: null, failureMessage: result.message });
    case "retryable":
      return updateOperation(db, id, { status: "pending", failureCode: null, failureMessage: result.message });
  }
}

/** The database's own message for an error Drizzle wrapped. */
export function databaseMessage(error: unknown): string {
  return (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
}
