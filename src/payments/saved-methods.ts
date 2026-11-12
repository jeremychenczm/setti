/**
 * The payment method a client saved for a project: what the client sees of it,
 * and removing it. The vault token itself never leaves the server.
 */
import { and, eq, inArray, notExists } from "drizzle-orm";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { paymentOperations, savedPaymentMethodRemovals, savedPaymentMethods } from "../db/schema";
import { pricingCases } from "../pricing/schema";
import { PaymentActionError } from "./binding";
import type { PayPalPayments, SavedMethodKind } from "./paypal";

type Reader = Pick<Db, "select">;
export type SavedMethodRow = typeof savedPaymentMethods.$inferSelect;

/** What a page may show about a saved payment method. */
export interface SavedMethodView {
  kind: SavedMethodKind;
  /** "Visa •••• 0026", "s•••@personal.example.com", or a generic name for methods saved before labels existed. */
  label: string;
  savedAt: string;
}

/** The project's saved payment method that the client has not removed, if any. */
export async function activeSavedMethod(db: Reader, projectId: string): Promise<SavedMethodRow | null> {
  const [row] = await db.select().from(savedPaymentMethods).where(and(
    eq(savedPaymentMethods.projectId, projectId),
    notExists(db.select({ methodId: savedPaymentMethodRemovals.methodId }).from(savedPaymentMethodRemovals).where(eq(savedPaymentMethodRemovals.methodId, savedPaymentMethods.id))),
  ));
  return row ?? null;
}

export function savedMethodView(row: SavedMethodRow | null): SavedMethodView | null {
  if (!row) return null;
  const kind: SavedMethodKind = row.kind === "card" ? "card" : "paypal";
  return { kind, label: row.label ?? (kind === "card" ? "Saved card" : "Saved PayPal account"), savedAt: row.createdAt.toISOString() };
}

/** Removes the saved payment method of the project this browser session owns. */
/** The payment project behind this browser's case, or null when it has none yet. */
async function caseProjectId(db: Reader, sessionId: string, key: CaseKey): Promise<string | null> {
  const [found] = await db.select({ projectId: pricingCases.projectId }).from(chatCases)
    .innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
    .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  return found?.projectId ?? null;
}

/** The case's saved payment method in any state of its versions, also while none is confirmed. */
export async function caseSavedMethod(db: Reader, sessionId: string, key: CaseKey): Promise<SavedMethodRow | null> {
  const projectId = await caseProjectId(db, sessionId, key);
  return projectId ? activeSavedMethod(db, projectId) : null;
}

export async function removeCaseSavedMethod(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey): Promise<void> {
  const projectId = await caseProjectId(db, sessionId, key);
  if (!projectId) throw new PaymentActionError("NOT_FOUND", "This project has no payment records in this browser.");
  await removeSavedMethod(db, paypal, projectId);
}

/**
 * The client removes the project's saved payment method. PayPal deletes the
 * token first, then Setti records the removal, and from then on the database
 * refuses any hold with it. Setti does not rely on PayPal for that: probe P12
 * saw PayPal still accept a just-deleted token once. Holds already placed with
 * it stay valid. Deleting is idempotent at PayPal (a second delete also answers 204).
 */
export async function removeSavedMethod(db: Db, paypal: PayPalPayments, projectId: string): Promise<void> {
  const method = await activeSavedMethod(db, projectId);
  if (!method) throw new PaymentActionError("NOT_AVAILABLE", "No saved payment method is active for this project.");
  const [busy] = await db.select({ id: paymentOperations.id }).from(paymentOperations)
    .where(and(eq(paymentOperations.savedMethodId, method.id), inArray(paymentOperations.status, ["pending", "unknown"])));
  if (busy) throw new PaymentActionError("NOT_AVAILABLE", "A hold with this payment method is still in progress. Check it before removing the method.");
  const deleted = await paypal.deleteSavedMethod(method.paypalTokenId);
  // A token PayPal no longer has was already deleted, for example by an earlier attempt whose answer was lost.
  const gone = deleted.kind === "rejected" && (deleted.trace?.httpStatus === 404 || ["RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID"].includes(deleted.code));
  if (deleted.kind !== "ok" && !gone) {
    throw new PaymentActionError("OPERATION_REFUSED", "PayPal did not confirm the removal. The payment method is still saved; try again.");
  }
  await db.insert(savedPaymentMethodRemovals).values({ methodId: method.id, projectId }).onConflictDoNothing();
}
