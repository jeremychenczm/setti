/**
 * Refund executor: returns money from one completed capture. Same shape as the
 * capture executor: write it down, call PayPal outside a transaction, write the
 * verified result back. A pending refund is recorded as pending (and counted as
 * reserved against the capture, never as returned money); a failed or
 * cancelled one fails the operation; an incomplete or different receipt leaves
 * the operation unknown for reconciliation. The database refuses refunds above
 * what is left of the capture.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalRefunds } from "../db/schema";
import { noteInCase } from "./notes";
import {
  claimOperation, databaseMessage, insertOperation, recordCall, recordFailure, updateOperation,
  type OperationBinding, type PaymentOperation, type PaypalCapture,
} from "./operations";
import type { PayPalPayments, PayPalResult, RefundReceipt } from "./paypal";
import { formatCents, refundMoneyStatus, verifyRefund } from "./receipts";

export type PaypalRefund = typeof paypalRefunds.$inferSelect;

/** Writes down a refund of one capture, once per business event. Nothing is sent to PayPal yet. */
export async function requestRefund(
  db: Pick<Db, "select" | "insert" | "update">,
  input: { businessKey: string; projectId: string; captureId: string; amountCents: number; binding?: OperationBinding; supplierEventId?: string | null },
): Promise<PaymentOperation> {
  return insertOperation(db, { kind: "refund", ...input });
}

/** Runs a refund operation once; finished operations are returned without calling PayPal again. */
export async function executeRefund(db: Db, paypal: PayPalPayments, operationId: string): Promise<PaymentOperation> {
  const claim = await claimOperation(db, operationId, "refund");
  if (claim.finished) return claim.operation;
  const { operation } = claim;
  const capture = claim.capture!;
  if (operation.paypalResourceId) {
    const read = await paypal.getRefund(operation.paypalResourceId);
    await logRefund(db, operation, "get_refund", null, read);
    if (read.kind !== "ok") return updateOperation(db, operation.id, { failureMessage: `PayPal refund ${operation.paypalResourceId} could not be read back: ${read.message}` });
    return settle(db, paypal, operation, capture, read.value, false);
  }
  const result = await paypal.refundCapture({ paypalCaptureId: capture.paypalCaptureId, amountCents: operation.amountCents, requestId: operation.requestId, customId: operation.id });
  await logRefund(db, operation, "refund", operation.requestId, result);
  return result.kind === "ok" ? settle(db, paypal, operation, capture, result.value, true) : recordFailure(db, operation.id, result);
}

/** Reads a pending refund back from PayPal and records where its money now stands. */
export async function refreshRefund(db: Db, paypal: PayPalPayments, refundId: string): Promise<PaypalRefund> {
  const [refund] = await db.select().from(paypalRefunds).where(eq(paypalRefunds.id, refundId));
  if (!refund) throw new Error(`Refund ${refundId} does not exist`);
  if (refund.status !== "pending" || !refund.operationId) return refund;
  const result = await paypal.getRefund(refund.paypalRefundId);
  await logRefund(db, { id: refund.operationId }, "get_refund", null, result);
  if (result.kind !== "ok") return refund;
  const verified = verifyRefund(result.value, refund.amountCents);
  if (!verified.ok || verified.value.status === "pending") return refund;
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(paypalRefunds).set({ status: verified.value.status }).where(eq(paypalRefunds.id, refund.id)).returning();
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, refund.operationId!));
    await noteInCase(tx, operation, ({ version, itemName }) => `PayPal Sandbox now reports the pending refund ${refund.paypalRefundId} for V${version} · ${itemName} as ${verified.value.status} (${formatCents(refund.amountCents)} USD).`);
    return updated;
  });
}

async function settle(db: Db, paypal: PayPalPayments, operation: PaymentOperation, capture: PaypalCapture, receipt: RefundReceipt, mayReadBack: boolean): Promise<PaymentOperation> {
  let verified = verifyRefund(receipt, operation.amountCents);
  if (!verified.ok && verified.code === "RECEIPT_INCOMPLETE" && receipt.paypalRefundId && mayReadBack) {
    // Read the refund back once before deciding anything about an incomplete receipt.
    const read = await paypal.getRefund(receipt.paypalRefundId);
    await logRefund(db, operation, "get_refund", null, read);
    if (read.kind === "ok") {
      receipt = read.value;
      verified = verifyRefund(read.value, operation.amountCents);
    }
  }
  if (!verified.ok) {
    return updateOperation(db, operation.id, {
      status: "unknown", failureCode: verified.code, failureMessage: verified.message,
      ...(receipt.paypalRefundId ? { paypalResourceId: receipt.paypalRefundId } : {}),
    });
  }
  const { paypalRefundId, status } = verified.value;
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: paypalRefunds.id }).from(paypalRefunds).where(eq(paypalRefunds.paypalRefundId, paypalRefundId));
      if (!existing) {
        await tx.insert(paypalRefunds).values({ captureId: capture.id, paypalRefundId, amountCents: operation.amountCents, currency: operation.currency, status, operationId: operation.id });
        await noteInCase(tx, operation, ({ version, itemName }) => status === "completed"
          ? `PayPal Sandbox refund completed for V${version} · ${itemName}: ${formatCents(operation.amountCents)} USD returned from capture ${capture.paypalCaptureId} (refund ${paypalRefundId}).`
          : status === "pending"
            ? `PayPal Sandbox reports the refund of ${formatCents(operation.amountCents)} USD for V${version} · ${itemName} as pending (refund ${paypalRefundId}); it is not counted as returned until PayPal completes it.`
            : `PayPal Sandbox reports the refund of ${formatCents(operation.amountCents)} USD for V${version} · ${itemName} as failed (refund ${paypalRefundId}); no money was returned.`);
      }
      const [done] = await tx.update(paymentOperations)
        .set(status === "failed"
          ? { status: "failed", paypalResourceId: paypalRefundId, failureCode: "REFUND_FAILED", failureMessage: "PayPal reports this refund as failed or cancelled; no money was returned.", updatedAt: new Date() }
          : { status: "succeeded", paypalResourceId: paypalRefundId, failureCode: null, failureMessage: null, updatedAt: new Date() })
        .where(eq(paymentOperations.id, operation.id)).returning();
      return done;
    });
  } catch (error) {
    // PayPal returned money our records refuse. Keep PayPal's id so a person can look into it.
    return updateOperation(db, operation.id, { status: "unknown", paypalResourceId: paypalRefundId, failureCode: "LOCAL_RECORD_REJECTED", failureMessage: databaseMessage(error) });
  }
}

function logRefund(db: Db, operation: Pick<PaymentOperation, "id">, step: "refund" | "get_refund", requestId: string | null, result: PayPalResult<RefundReceipt>) {
  const receipt = result.kind === "ok" ? result.value : undefined;
  return recordCall(db, operation.id, step, requestId, result, receipt && {
    resourceId: receipt.paypalRefundId, status: receipt.status, amountCents: receipt.amountCents, currency: receipt.currency,
    details: { createTime: receipt.createTime, money: refundMoneyStatus(receipt.status) ?? null },
  });
}
