/**
 * Holds every approved furniture item the agreement still needs to fund, with
 * the project's saved PayPal: one PayPal authorization per item and no
 * checkout. Each item is its own business event, so running this again never
 * holds an item twice; it resumes holds whose outcome is still open and retries
 * items whose earlier hold failed. One item failing leaves the others as they are.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { chatCases } from "../chat/schema";
import { pricingCases } from "../pricing/schema";
import { items, paymentOperations, savedPaymentMethods } from "../db/schema";
import { attempt, checkoutDetails, type LinkBuilder } from "./actions";
import { cancelCheckout } from "./authorize";
import { PaymentActionError } from "./binding";
import { insertOperation, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { executeSavedHold } from "./saved-hold";
import { lockPaymentBasis } from "./services";

/** PayPal Sandbox handles a few holds at once; more would only queue up. */
const AT_ONCE = 4;

export async function holdApprovedItems(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, links?: LinkBuilder): Promise<PaymentOperation[]> {
  const operations = await db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, sessionId, key);
    const [saved] = await tx.select({ id: savedPaymentMethods.id }).from(savedPaymentMethods).where(eq(savedPaymentMethods.projectId, basis.projectId));
    if (!saved) throw new PaymentActionError("NOT_AVAILABLE", "The client has not saved PayPal for this project yet. Paying the design services saves it.");
    // Holds whose outcome is still open come first; the plan waits for them.
    const open = basis.ledger.operations.filter((operation) => operation.savedMethodId && (operation.status === "pending" || operation.status === "unknown"));
    if (open.length) return open;
    if (basis.plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before holding items.", basis.plan.blockers);
    const wanted = basis.plan.actions.flatMap((action) => {
      const itemId = basis.businessItem(action);
      return action.kind === "new_authorization" && itemId ? [{ itemId, amountCents: action.amountCents }] : [];
    });
    const furniture = wanted.length ? new Set((await tx.select({ id: items.id }).from(items)
      .where(and(inArray(items.id, wanted.map((entry) => entry.itemId)), eq(items.kind, "furniture")))).map((row) => row.id)) : new Set<string>();
    const created: PaymentOperation[] = [];
    for (const { itemId, amountCents } of wanted.filter((entry) => furniture.has(entry.itemId))) {
      const prefix = `saved-hold:${basis.key}:${itemId}:`;
      created.push(await insertOperation(tx, { businessKey: `${prefix}${attempt(basis.ledger, "authorize", prefix)}`, projectId: basis.projectId, kind: "authorize", amountCents, binding: basis.bind(itemId), savedMethodId: saved.id }));
    }
    return created;
  });

  const results: PaymentOperation[] = new Array(operations.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, operations.length) }, async () => {
    while (next < operations.length) {
      const index = next++;
      results[index] = await executeSavedHold(db, paypal, operations[index].id, await checkoutDetails(db, operations[index]), links?.(operations[index].id));
    }
  }));
  return results;
}

/** Existing holds remain reconcilable after the client confirms a newer version of this project. */
async function ownedItemHold(db: Db, sessionId: string, key: CaseKey, operationId: string): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    // Reconciliation needs ownership, not a currently executable funding plan: the old
    // order must remain recoverable while a replacement quote is still awaiting approval.
    const [project] = await tx.select({ projectId: pricingCases.projectId }).from(chatCases)
      .innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
      .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
    if (!project || !operation || operation.projectId !== project.projectId || operation.kind !== "authorize" || !operation.savedMethodId || !operation.itemId) throw new PaymentActionError("NOT_FOUND", "This item hold does not belong to this project.");
    return operation;
  });
}

export async function checkItemHold(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, operationId: string): Promise<PaymentOperation> {
  const operation = await ownedItemHold(db, sessionId, key, operationId);
  return executeSavedHold(db, paypal, operation.id, await checkoutDetails(db, operation));
}

export async function cancelItemHold(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, operationId: string): Promise<PaymentOperation> {
  const operation = await ownedItemHold(db, sessionId, key, operationId);
  if (!operation.approvalUrl) throw new PaymentActionError("NOT_AVAILABLE", "Only a hold waiting for client approval can leave checkout.");
  return (await cancelCheckout(db, paypal, operation.id, true)).operation;
}
