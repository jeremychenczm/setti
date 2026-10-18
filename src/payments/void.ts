/**
 * Void executor: releases what is still held on an authorization. Same shape
 * as the capture executor: write it down, call PayPal outside a transaction,
 * write the result back. Once voided, the database refuses further captures.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations } from "../db/schema";
import { holdSummary } from "./holds";
import { claimOperation, newOperationIds, recordFailure, type PaymentOperation, type PaypalAuthorization } from "./operations";
import type { PayPalPayments } from "./paypal";

/** Writes down a void. The amount recorded is what is still held right now. */
export async function requestVoid(db: Db, input: { projectId: string; authorizationId: string }): Promise<PaymentOperation> {
  const { heldCents } = await holdSummary(db, input.authorizationId);
  if (heldCents <= 0) throw new Error(`Nothing is left on hold on authorization ${input.authorizationId}`);

  const [operation] = await db
    .insert(paymentOperations)
    .values({ ...newOperationIds(), projectId: input.projectId, kind: "void", authorizationId: input.authorizationId, amountCents: heldCents })
    .returning();
  return operation;
}

/** Runs a void operation once; finished operations are returned without calling PayPal. */
export async function executeVoid(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "void");
  if (claim.finished) return claim.operation;

  const { operation, authorization } = claim;
  const result = await paypal.voidAuthorization({ paypalAuthorizationId: authorization.paypalAuthorizationId, requestId: operation.requestId });
  return result.kind === "ok" ? recordVoid(db, operation, authorization) : recordFailure(db, operation.id, result);
}

async function recordVoid(db: Db, operation: PaymentOperation, authorization: PaypalAuthorization): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    await tx.update(paypalAuthorizations).set({ status: "voided" }).where(eq(paypalAuthorizations.id, authorization.id));
    const [done] = await tx
      .update(paymentOperations)
      .set({ status: "succeeded", paypalResourceId: authorization.paypalAuthorizationId, failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operation.id))
      .returning();
    return done;
  });
}
