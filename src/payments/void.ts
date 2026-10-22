/**
 * Void executor: releases what is still held on an authorization. Same shape
 * as the capture executor: write it down, call PayPal outside a transaction,
 * write the result back. Once voided, the database refuses further captures.
 * PayPal cannot void part of a hold, so a void always releases everything left.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations } from "../db/schema";
import { holdSummary } from "./holds";
import {
  claimOperation, findOperation, insertOperation, recordCall, recordFailure, updateOperation,
  type OperationBinding, type PaymentOperation, type PaypalAuthorization,
} from "./operations";
import type { AuthorizationReceipt, PayPalPayments, PayPalResult } from "./paypal";
import { noteInCase } from "./notes";
import { formatCents, holdStatus } from "./receipts";

/** Writes down a void, once per business event. The amount recorded is what is still held right now. */
export async function requestVoid(
  db: Db,
  input: { businessKey: string; projectId: string; authorizationId: string; binding?: OperationBinding },
): Promise<PaymentOperation> {
  const existing = await findOperation(db, input.businessKey);
  if (existing) return insertOperation(db, { kind: "void", ...input, amountCents: existing.amountCents });
  const { heldCents } = await holdSummary(db, input.authorizationId);
  if (heldCents <= 0) throw new Error(`Nothing is left on hold on authorization ${input.authorizationId}`);
  return insertOperation(db, { kind: "void", ...input, amountCents: heldCents });
}

/** Runs a void operation once; finished operations are returned without calling PayPal. */
export async function executeVoid(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "void");
  if (claim.finished) return claim.operation;

  const { operation } = claim;
  const authorization = claim.authorization!;
  const result = await paypal.voidAuthorization({ paypalAuthorizationId: authorization.paypalAuthorizationId, requestId: operation.requestId });
  await logHold(db, operation, "void", operation.requestId, result);
  if (result.kind !== "ok") return voidRefused(db, paypal, operation, authorization, result);

  let status = holdStatus(result.value.status);
  if (!status) {
    // PayPal accepted the call but did not say what the hold is now; read it back.
    const read = await paypal.getAuthorization(authorization.paypalAuthorizationId);
    await logHold(db, operation, "get_authorization", null, read);
    status = read.kind === "ok" ? holdStatus(read.value.status) : undefined;
  }
  if (status !== "voided") {
    return updateOperation(db, operation.id, { status: "unknown", failureCode: "RECEIPT_INCOMPLETE", failureMessage: `PayPal did not confirm the hold as voided (${status ?? "no status"}).` });
  }
  return recordVoid(db, operation, authorization);
}

async function recordVoid(db: Db, operation: PaymentOperation, authorization: PaypalAuthorization): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    await tx.update(paypalAuthorizations).set({ status: "voided" }).where(eq(paypalAuthorizations.id, authorization.id));
    await noteInCase(tx, operation, ({ version, itemName }) => `PayPal Sandbox released the hold for V${version} · ${itemName}: authorization ${authorization.paypalAuthorizationId} is voided and ${formatCents(operation.amountCents)} USD is no longer held. This is a release, not a refund; nothing was charged.`);
    const [done] = await tx
      .update(paymentOperations)
      .set({ status: "succeeded", paypalResourceId: authorization.paypalAuthorizationId, failureCode: null, failureMessage: null, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operation.id))
      .returning();
    return done;
  });
}

/** A refused void fails. When PayPal says the hold already ended, the hold's real state is read back and kept. */
async function voidRefused(db: Db, paypal: PayPalPayments, operation: PaymentOperation, authorization: PaypalAuthorization, result: Exclude<PayPalResult<unknown>, { kind: "ok" }>): Promise<PaymentOperation> {
  if (result.kind !== "rejected" || !["AUTHORIZATION_VOIDED", "AUTHORIZATION_EXPIRED"].includes(result.code)) return recordFailure(db, operation.id, result);
  const read = await paypal.getAuthorization(authorization.paypalAuthorizationId);
  await logHold(db, operation, "get_authorization", null, read);
  const status = read.kind === "ok" ? holdStatus(read.value.status) : undefined;
  const closed = status === "voided" ? "voided" : result.code === "AUTHORIZATION_EXPIRED" ? "expired" : null;
  return db.transaction(async (tx) => {
    const [auth] = await tx.select({ status: paypalAuthorizations.status }).from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorization.id)).for("update");
    if (closed && (auth.status === "created" || auth.status === "partially_captured")) await tx.update(paypalAuthorizations).set({ status: closed }).where(eq(paypalAuthorizations.id, authorization.id));
    return recordFailure(tx, operation.id, result);
  });
}

function logHold(db: Db, operation: PaymentOperation, step: "void" | "get_authorization", requestId: string | null, result: PayPalResult<AuthorizationReceipt>) {
  const receipt = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, step, requestId, result, receipt && {
    resourceId: receipt.paypalAuthorizationId, status: receipt.status, amountCents: receipt.amountCents, currency: receipt.currency,
    details: { reportedAmountIsOriginal: true, expirationTime: receipt.expirationTime },
  });
}
