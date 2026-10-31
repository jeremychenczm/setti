/**
 * Holds every approved furniture item the agreement still needs to fund, with
 * the project's saved payment method: one PayPal authorization per item and no
 * checkout. Each item is its own business event, so running this again never
 * holds an item twice; it resumes holds whose outcome is still open and retries
 * items whose earlier hold failed. One item failing leaves the others as they are.
 * Without a saved method, the client holds one item at a time through a checkout.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { chatCases } from "../chat/schema";
import { pricingCases } from "../pricing/schema";
import { items, paymentOperations } from "../db/schema";
import { activeSavedMethod } from "./saved-methods";
import { attempt, checkoutDetails, type LinkBuilder } from "./actions";
import { cancelCheckout, completeAuthorization, createCheckout } from "./authorize";
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
    const saved = await activeSavedMethod(tx, basis.projectId);
    if (!saved) throw new PaymentActionError("NOT_AVAILABLE", "The client has no saved payment method for this project. Paying with PayPal or a card can save one.");
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

/**
 * The client holds one approved item of the current agreement through a checkout
 * (the PayPal window or the Sandbox test card), when no payment method is saved.
 * `save` is the client's consent to save the method for the project's later holds.
 * An open checkout for the same item is resumed, never duplicated.
 */
export async function startItemCheckout(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, quoteItemId: string, links: LinkBuilder, options: { save?: boolean } = {}): Promise<PaymentOperation> {
  const operation = await db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, sessionId, key);
    // The item is found from its quote line, not from the plan: an open checkout blocks the plan's actions.
    const line = basis.plan.lines.find((entry) => entry.itemId === quoteItemId);
    const itemId = line && basis.businessItem(line);
    const open = itemId ? basis.ledger.operations.find((entry) => entry.kind === "authorize" && entry.itemId === itemId && (entry.status === "pending" || entry.status === "unknown")) : undefined;
    if (open && !open.savedMethodId) return open;
    const action = basis.plan.actions.find((entry) => entry.kind === "new_authorization" && entry.itemId === quoteItemId);
    if (open) throw new PaymentActionError("PLAN_BLOCKED", "A hold for this item is still open. Check it before starting another.");
    if (basis.plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before holding items.", basis.plan.blockers);
    if (!action || !itemId) throw new PaymentActionError("NOT_AVAILABLE", "This item needs no new hold under the current agreement.");
    const [item] = await tx.select({ kind: items.kind }).from(items).where(eq(items.id, itemId));
    if (item?.kind !== "furniture") throw new PaymentActionError("NOT_AVAILABLE", "Only approved furniture items are held one by one.");
    const saved = await activeSavedMethod(tx, basis.projectId);
    if (saved) throw new PaymentActionError("NOT_AVAILABLE", "A payment method is saved for this project. Hold the items with it instead.");
    const prefix = `item-checkout:${basis.key}:${itemId}:`;
    return insertOperation(tx, { businessKey: `${prefix}${attempt(basis.ledger, "authorize", prefix)}`, projectId: basis.projectId, kind: "authorize", amountCents: action.amountCents, binding: basis.bind(itemId), savePaymentMethod: !!options.save });
  });
  return createCheckout(db, paypal, operation, links(operation.id), await checkoutDetails(db, operation));
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
    if (!project || !operation || operation.projectId !== project.projectId || operation.kind !== "authorize" || !operation.itemId || operation.servicesHold) throw new PaymentActionError("NOT_FOUND", "This item hold does not belong to this project.");
    return operation;
  });
}

export async function checkItemHold(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, operationId: string, links?: LinkBuilder): Promise<PaymentOperation> {
  const operation = await ownedItemHold(db, sessionId, key, operationId);
  if (operation.savedMethodId) return executeSavedHold(db, paypal, operation.id, await checkoutDetails(db, operation));
  // A checkout whose order was never created is created now, with the same request id.
  if (!operation.paypalOrderId && links && (operation.status === "pending" || operation.status === "unknown")) return createCheckout(db, paypal, operation, links(operation.id), await checkoutDetails(db, operation));
  return (await completeAuthorization(db, paypal, operation.id)).operation;
}

export async function cancelItemHold(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, operationId: string): Promise<PaymentOperation> {
  const operation = await ownedItemHold(db, sessionId, key, operationId);
  if (!operation.approvalUrl) throw new PaymentActionError("NOT_AVAILABLE", "Only a hold waiting for client approval can leave checkout.");
  return (await cancelCheckout(db, paypal, operation.id, !!operation.savedMethodId)).operation;
}
