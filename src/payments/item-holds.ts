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
import { items, savedPaymentMethods } from "../db/schema";
import { attempt, checkoutDetails } from "./actions";
import { PaymentActionError } from "./binding";
import { insertOperation, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { executeSavedHold } from "./saved-hold";
import { lockPaymentBasis } from "./services";

/** PayPal Sandbox handles a few holds at once; more would only queue up. */
const AT_ONCE = 4;

export async function holdApprovedItems(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey): Promise<PaymentOperation[]> {
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
      results[index] = await executeSavedHold(db, paypal, operations[index].id, await checkoutDetails(db, operations[index]));
    }
  }));
  return results;
}
