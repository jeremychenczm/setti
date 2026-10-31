/** Real V1 payment preparation. Every retry resumes its original recorded operation. */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalCaptures, servicesHoldLines } from "../db/schema";
import { checkoutDetails, returnFromPayPal, startOpeningCapture } from "../payments/actions";
import { completeAuthorization, createCheckout } from "../payments/authorize";
import { executeCapture, refreshCapture } from "../payments/capture";
import { lockOpeningVersion, openingPlan } from "../payments/opening";
import { insertOperation } from "../payments/operations";
import { checkServicesCheckout, lockPaymentBasis } from "../payments/services";
import { recordOpeningSupplierOrder } from "../payments/supplier";
import { refreshOpeningRecordedFees } from "../payments/fee-refresh";
import { MaplePreparationError } from "./maple";
import type { TryDeps } from "./service";

/** Historical V1 service payment, using the same service capture path as checkout.
 * The client paid with PayPal's Sandbox test card and agreed to save it for the
 * project, so later item holds need no PayPal window. It is labelled as a card,
 * never as the visitor's PayPal wallet.
 */
export async function prepareHomeServices(deps: TryDeps, session: string): Promise<string[]> {
  const operation = await deps.db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, session, "maple");
    if (basis.version !== 1) throw new MaplePreparationError("The V1 service payment cannot be added to a later agreement.", false);
    const prior = basis.ledger.operations.find((entry) => entry.servicesHold && entry.revisionId === basis.key);
    if (prior) return prior;
    const action = basis.plan.actions.find((entry) => entry.itemId === "design" && entry.kind === "capture" && entry.timing === "on_payment_execution");
    const itemId = action && basis.businessItem(action);
    if (!action || !itemId) throw new MaplePreparationError("The V1 design service has no payment to prepare.", false);
    const created = await insertOperation(tx, { businessKey: `try-v1-services:${basis.key}`, projectId: basis.projectId, kind: "authorize", amountCents: action.amountCents, binding: basis.bind(null), servicesHold: true, savePaymentMethod: true });
    await tx.insert(servicesHoldLines).values({ operationId: created.id, itemId, amountCents: action.amountCents });
    return created;
  });
  if (operation.status === "failed") throw new MaplePreparationError("The original V1 service checkout was refused and needs review.", false);
  const checkout = await createCheckout(deps.db, deps.paypal, operation, deps.links(operation.id), await checkoutDetails(deps.db, operation));
  if (checkout.status === "failed") throw new MaplePreparationError("PayPal refused the original V1 service checkout.", false);
  if (!checkout.paypalOrderId) throw new MaplePreparationError("The original V1 service checkout has no confirmed order yet.");
  if (checkout.status !== "succeeded") {
    const found = await deps.paypal.getOrder(checkout.paypalOrderId);
    if (found.kind !== "ok") throw new MaplePreparationError("The original V1 service checkout could not be checked.");
    if (!["APPROVED", "COMPLETED"].includes(found.value.status ?? "")) {
      const approved = await deps.testCard(checkout.paypalOrderId, { save: checkout.savePaymentMethod });
      if (approved.kind !== "ok" || !["APPROVED", "COMPLETED"].includes(approved.value.status ?? "")) throw new MaplePreparationError("The original V1 service checkout still needs approval.", approved.kind !== "rejected");
    }
  }
  const result = await checkServicesCheckout(deps.db, deps.paypal, session, "maple", checkout.id, deps.links);
  if (result.state !== "authorized") throw new MaplePreparationError("The original V1 service authorization is not confirmed.", result.state !== "failed");
  const { ledger } = await deps.db.transaction((tx) => lockPaymentBasis(tx, session, "maple"));
  const hold = ledger.authorizations.find((entry) => entry.operationId === checkout.id);
  const captures = ledger.captures.filter((entry) => entry.authorizationId === hold?.id);
  if (!captures.length || captures.some((entry) => entry.status !== "completed") || captures.reduce((sum, entry) => sum + entry.amountCents, 0) !== checkout.amountCents) throw new MaplePreparationError("The original V1 service capture is not confirmed.");
  return [checkout.id, ...ledger.operations.filter((entry) => entry.kind === "capture" && entry.authorizationId === hold!.id).map((entry) => entry.id)];
}

async function ownedOperation(db: Db, session: string, itemId: string, kind: "authorize" | "capture") {
  return db.transaction(async (tx) => {
    const version = await lockOpeningVersion(tx, session, "maple", null);
    const entry = version.approved.find((line) => line.line.itemId === itemId);
    if (!entry) throw new MaplePreparationError("The prepared V1 item is unavailable.", false);
    const [operation] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.revisionId, version.revisionId), isNull(paymentOperations.changeOrderId), eq(paymentOperations.itemId, entry.itemId), eq(paymentOperations.kind, kind))).orderBy(paymentOperations.createdAt).limit(1);
    return { version, entry, operation };
  });
}

export async function prepareHomeHold(deps: TryDeps, session: string, itemId: string): Promise<string[]> {
  const { version, entry, operation: prior } = await ownedOperation(deps.db, session, itemId, "authorize");
  if (prior?.status === "succeeded") return [prior.id];
  if (prior?.status === "failed") throw new MaplePreparationError("The original V1 authorization was refused and needs review.", false);
  const operation = prior ?? await deps.db.transaction(async (tx) => {
    const current = await lockOpeningVersion(tx, session, "maple", { contentHash: version.contentHash });
    const { plan } = await openingPlan(tx, current);
    if (plan.status === "blocked") throw new MaplePreparationError("The original V1 payment plan has unresolved operations.");
    const action = plan.actions.find((candidate) => candidate.kind === "new_authorization" && candidate.itemId === itemId && candidate.side === "baseline");
    if (!action) throw new MaplePreparationError("The V1 furniture line has no authorization to prepare.", false);
    return insertOperation(tx, { businessKey: `try-v1-hold:${current.revisionId}:${entry.itemId}`, projectId: current.projectId, kind: "authorize", amountCents: action.amountCents, binding: current.bind(entry.itemId) });
  });
  let checkout = await createCheckout(deps.db, deps.paypal, operation, deps.links(operation.id), await checkoutDetails(deps.db, operation));
  if (checkout.status === "failed") throw new MaplePreparationError("PayPal refused the original V1 checkout.", false);
  if (checkout.paypalOrderId && !checkout.approvalUrl) checkout = (await completeAuthorization(deps.db, deps.paypal, checkout.id)).operation;
  if (checkout.status === "succeeded") return [checkout.id];
  if (!checkout.paypalOrderId || !checkout.approvalUrl) throw new MaplePreparationError("PayPal did not return the original V1 checkout's approval link.");
  const found = await deps.paypal.getOrder(checkout.paypalOrderId);
  if (found.kind !== "ok") throw new MaplePreparationError("The original V1 PayPal order could not be checked.");
  if (!["APPROVED", "COMPLETED"].includes(found.value.status ?? "")) {
    const approved = await deps.testCard(checkout.paypalOrderId);
    if (approved.kind !== "ok" || !["APPROVED", "COMPLETED"].includes(approved.value.status ?? "")) {
      const checked = await deps.paypal.getOrder(checkout.paypalOrderId);
      if (checked.kind !== "ok" || !["APPROVED", "COMPLETED"].includes(checked.value.status ?? "")) throw new MaplePreparationError("The original V1 checkout still needs approval.", approved.kind !== "rejected");
    }
  }
  const result = await returnFromPayPal(deps.db, deps.paypal, checkout.id, checkout.paypalOrderId, "return");
  if (result?.state !== "authorized") throw new MaplePreparationError("The original V1 authorization has not been confirmed.");
  return [checkout.id];
}

export async function prepareHomeSupplier(db: Db, session: string): Promise<void> {
  const { version, entry } = await ownedOperation(db, session, "sideboard", "authorize");
  const line = entry.line;
  await recordOpeningSupplierOrder(db, session, "maple", { itemId: "sideboard", contentHash: version.contentHash,
    quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
    inStock: true, leadTimeDays: line.leadTimeDays, reference: "DEMO-V1-ORDER-sideboard", note: "Prepared fictional sideboard supplier confirmation; payment evidence is recorded separately." });
}

export async function prepareHomeCapture(deps: TryDeps, session: string): Promise<string[]> {
  const { version, operation: prior } = await ownedOperation(deps.db, session, "sideboard", "capture");
  if (prior?.status === "failed") throw new MaplePreparationError("The original V1 sideboard capture was refused and needs review.", false);
  const operations = prior ? [await executeCapture(deps.db, deps.paypal, prior.id)] : await startOpeningCapture(deps.db, deps.paypal, session, "maple", { itemId: "sideboard", contentHash: version.contentHash });
  for (const operation of operations) {
    if (operation.status !== "succeeded") throw new MaplePreparationError("The original V1 sideboard capture is not confirmed.", operation.status !== "failed");
    const [capture] = await deps.db.select().from(paypalCaptures).where(eq(paypalCaptures.operationId, operation.id));
    const receipt = capture?.status === "pending" ? await refreshCapture(deps.db, deps.paypal, capture.id) : capture;
    if (receipt?.status !== "completed") throw new MaplePreparationError("The original V1 sideboard capture is still pending.", receipt?.status !== "declined");
  }
  return operations.map((operation) => operation.id);
}

export const refreshHomeFees = (deps: TryDeps, session: string) => refreshOpeningRecordedFees(deps.db, deps.paypal, session, "maple");
