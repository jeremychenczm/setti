/**
 * Shared steps of every money move: write it down once per business event,
 * claim it for one attempt, log each PayPal call, and write the outcome back.
 * PayPal is always called between `claimOperation` and the write-back, outside
 * any database transaction.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalAuthorizations, paypalCaptures } from "../db/schema";
import type { PayPalResult } from "./paypal";
import { paypalCalls, type PayPalStep } from "./schema";

export type PaymentOperation = typeof paymentOperations.$inferSelect;
export type PaypalAuthorization = typeof paypalAuthorizations.$inferSelect;
export type PaypalCapture = typeof paypalCaptures.$inferSelect;
type OperationKind = PaymentOperation["kind"];
/** A database handle or an open transaction. */
export type Writer = Pick<Db, "select" | "insert" | "update">;

export class PaymentOperationError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "OPERATION_REFUSED", message: string) {
    super(message);
    this.name = "PaymentOperationError";
  }
}

/**
 * The client-confirmed version an operation executes. The database checks it again on insert.
 * A V1 signed line by line has no change order; its hashes are the V1 document's and revision's.
 */
export interface OperationBinding {
  changeOrderId: string | null;
  revisionId: string;
  contentHash: string;
  revisionContentHash: string;
  /** Business item UUID; a replacement keeps the quote's item id but is a different business item. Null only for the design-services hold. */
  itemId: string | null;
}

export interface OperationRequest {
  /** Names one business event, so a repeated click finds the same operation. */
  businessKey: string;
  projectId: string;
  kind: OperationKind;
  amountCents: number;
  authorizationId?: string | null;
  captureId?: string | null;
  finalCapture?: boolean;
  binding?: OperationBinding | null;
  /** The supplier confirmation a capture relies on, or the supplier credit a refund waits for. */
  supplierEventId?: string | null;
  /** A checkout that also saves the client's PayPal for this project. */
  savePaymentMethod?: boolean;
  /** A hold placed with the project's saved PayPal instead of a checkout. */
  savedMethodId?: string | null;
  /** The one checkout that holds every approved design service; its split is written separately. */
  servicesHold?: boolean;
}

/** A new operation id and the request id every attempt of it sends to PayPal. */
export function newOperationIds(): { id: string; requestId: string } {
  const id = randomUUID();
  return { id, requestId: `setti-op-${id}` };
}

export async function findOperation(db: Writer, businessKey: string): Promise<PaymentOperation | undefined> {
  const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.businessKey, businessKey));
  return operation;
}

function sameRequest(operation: PaymentOperation, request: OperationRequest): PaymentOperation {
  const binding = request.binding ?? null;
  const same = operation.kind === request.kind && operation.projectId === request.projectId && operation.amountCents === request.amountCents
    && operation.authorizationId === (request.authorizationId ?? null) && operation.captureId === (request.captureId ?? null)
    && operation.finalCapture === (request.finalCapture ?? false)
    && operation.changeOrderId === (binding?.changeOrderId ?? null) && operation.revisionId === (binding?.revisionId ?? null)
    && operation.contentHash === (binding?.contentHash ?? null) && operation.revisionContentHash === (binding?.revisionContentHash ?? null)
    && operation.itemId === (binding?.itemId ?? null) && operation.supplierEventId === (request.supplierEventId ?? null)
    && operation.savePaymentMethod === (request.savePaymentMethod ?? false) && operation.savedMethodId === (request.savedMethodId ?? null)
    && operation.servicesHold === (request.servicesHold ?? false);
  if (!same) throw new PaymentOperationError("IDEMPOTENCY_CONFLICT", "This business event already has a payment operation with different details.");
  return operation;
}

/**
 * Writes down the operation for one business event, or returns the one already
 * written for it. Nothing is sent to PayPal. The database refuses operations
 * that start from a stale version, use another project's money, or would run
 * next to an unresolved move on the same hold or capture.
 */
export async function insertOperation(db: Writer, request: OperationRequest): Promise<PaymentOperation> {
  const existing = await findOperation(db, request.businessKey);
  if (existing) return sameRequest(existing, request);
  const binding = request.binding ?? null;
  let created: PaymentOperation | undefined;
  try {
    [created] = await db.insert(paymentOperations).values({
      ...newOperationIds(),
      businessKey: request.businessKey,
      projectId: request.projectId,
      kind: request.kind,
      amountCents: request.amountCents,
      authorizationId: request.authorizationId ?? null,
      captureId: request.captureId ?? null,
      finalCapture: request.finalCapture ?? false,
      changeOrderId: binding?.changeOrderId ?? null,
      revisionId: binding?.revisionId ?? null,
      contentHash: binding?.contentHash ?? null,
      revisionContentHash: binding?.revisionContentHash ?? null,
      itemId: binding?.itemId ?? null,
      supplierEventId: request.supplierEventId ?? null,
      savePaymentMethod: request.savePaymentMethod ?? false,
      savedMethodId: request.savedMethodId ?? null,
      servicesHold: request.servicesHold ?? false,
    }).onConflictDoNothing({ target: paymentOperations.businessKey }).returning();
  } catch (error) {
    throw new PaymentOperationError("OPERATION_REFUSED", databaseMessage(error));
  }
  if (created) return created;
  // Another request wrote the same business event first.
  const raced = await findOperation(db, request.businessKey);
  if (!raced) throw new Error(`Payment operation ${request.businessKey} could not be written`);
  return sameRequest(raced, request);
}

export type Claim =
  | { finished: true; operation: PaymentOperation }
  | { finished: false; operation: PaymentOperation; authorization: PaypalAuthorization | null; capture: PaypalCapture | null };

/**
 * Locks the operation, returns it untouched if it already succeeded or failed,
 * and otherwise counts one more attempt and loads the hold or capture it acts on.
 */
export async function claimOperation(db: Db, operationId: string, kind: OperationKind): Promise<Claim> {
  return db.transaction(async (tx) => {
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId)).for("update");
    if (!operation) throw new Error(`Payment operation ${operationId} does not exist`);
    if (operation.kind !== kind) throw new Error(`Payment operation ${operationId} is a ${operation.kind}, not a ${kind}`);
    if (operation.status === "succeeded" || operation.status === "failed") return { finished: true, operation };

    const [authorization] = operation.authorizationId ? await tx.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, operation.authorizationId)) : [];
    const [capture] = operation.captureId ? await tx.select().from(paypalCaptures).where(eq(paypalCaptures.id, operation.captureId)) : [];
    const [counted] = await tx
      .update(paymentOperations)
      .set({ attempts: operation.attempts + 1, updatedAt: new Date() })
      .where(eq(paymentOperations.id, operationId))
      .returning();
    return { finished: false, operation: counted, authorization: authorization ?? null, capture: capture ?? null };
  });
}

export async function updateOperation(db: Writer, id: string, fields: Partial<typeof paymentOperations.$inferInsert>): Promise<PaymentOperation> {
  const [operation] = await db
    .update(paymentOperations)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(paymentOperations.id, id))
    .returning();
  return operation;
}

/** Writes back a call that did not succeed: rejected fails, unknown waits for a retry, retryable stays pending. */
export function recordFailure(db: Writer, id: string, result: Exclude<PayPalResult<unknown>, { kind: "ok" }>): Promise<PaymentOperation> {
  switch (result.kind) {
    case "rejected":
      return updateOperation(db, id, { status: "failed", failureCode: result.code, failureMessage: result.message });
    case "unknown":
      return updateOperation(db, id, { status: "unknown", failureCode: null, failureMessage: result.message });
    case "retryable":
      return updateOperation(db, id, { status: "pending", failureCode: null, failureMessage: result.message });
  }
}

/** The receipt fields worth keeping as evidence of one call. */
export interface CallEvidence {
  resourceId?: string;
  status?: string;
  amountCents?: number;
  currency?: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}

/** Appends one PayPal call to the operation's evidence log. */
export async function recordCall(db: Writer, operationId: string, step: PayPalStep, requestId: string | null, result: PayPalResult<unknown>, evidence: CallEvidence = {}): Promise<void> {
  const details = Object.fromEntries(Object.entries(evidence.details ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean | null>;
  await db.insert(paypalCalls).values({
    operationId, step, requestId, outcome: result.kind,
    httpStatus: result.trace?.httpStatus ?? null,
    debugId: result.trace?.debugId ?? (result.kind === "rejected" ? result.debugId ?? null : null),
    resourceId: evidence.resourceId ?? null, resourceStatus: evidence.status ?? null,
    amountCents: evidence.amountCents ?? null, currency: evidence.currency ?? null,
    errorCode: result.kind === "rejected" ? result.code : null,
    message: result.kind === "ok" ? null : result.message.slice(0, 2_000),
    details,
  });
}

/** The database's own message for an error Drizzle wrapped. */
export function databaseMessage(error: unknown): string {
  return (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
}
