/**
 * Test helpers for payment operations. The request* helpers write down one
 * operation directly, as a business event would, without going through a
 * confirmed version; nothing is sent to PayPal. The app itself records
 * operations through the actions in ../actions.ts. holdSummary reads where a
 * hold stands, for assertions.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { paypalAuthorizations, paypalCaptures } from "../../db/schema";
import { summarizeHold, type HoldSummary } from "../holds";
import { findOperation, insertOperation, type OperationBinding, type PaymentOperation } from "../operations";

/** A capture to be made, once per business event. */
export async function requestCapture(
  db: Pick<Db, "select" | "insert" | "update">,
  input: { businessKey: string; projectId: string; authorizationId: string; amountCents: number; finalCapture?: boolean; binding?: OperationBinding },
): Promise<PaymentOperation> {
  return insertOperation(db, { kind: "capture", ...input });
}

/** A void, once per business event. The amount recorded is what is still held right now. */
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

/** A refund of one capture, once per business event. */
export async function requestRefund(
  db: Pick<Db, "select" | "insert" | "update">,
  input: { businessKey: string; projectId: string; captureId: string; amountCents: number; binding?: OperationBinding; supplierEventId?: string | null },
): Promise<PaymentOperation> {
  return insertOperation(db, { kind: "refund", ...input });
}

/** Where one hold stands, read from the recorded authorization and its captures. */
export async function holdSummary(db: Db, authorizationId: string): Promise<HoldSummary> {
  const [authorization] = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId));
  if (!authorization) throw new Error(`Authorization ${authorizationId} does not exist`);

  const captures = await db
    .select({ amountCents: paypalCaptures.amountCents, finalCapture: paypalCaptures.finalCapture, status: paypalCaptures.status })
    .from(paypalCaptures)
    .where(eq(paypalCaptures.authorizationId, authorizationId));

  const completed = captures.filter((capture) => capture.status === "completed");
  const closed = ["voided", "expired", "captured"].includes(authorization.status) || completed.some((capture) => capture.finalCapture)
    || !!(authorization.expiresAt && authorization.expiresAt.getTime() <= Date.now());
  return summarizeHold({
    authorizedCents: authorization.amountCents,
    capturedCents: completed.reduce((total, capture) => total + capture.amountCents, 0),
    pendingCaptureCents: captures.filter((capture) => capture.status === "pending").reduce((total, capture) => total + capture.amountCents, 0),
    closed,
  });
}
