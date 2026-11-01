/**
 * What follows the client's design-services payment, in one place: each service
 * is captured, then every approved furniture item is held with the payment
 * method the project has saved, as the client was told before paying, and the
 * client's message hands the next step to the designer. Furniture held here is
 * charged only after its supplier confirms it.
 */
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { LinkBuilder } from "./actions";
import { PaymentActionError } from "./binding";
import { holdApprovedItems } from "./item-holds";
import { noteServicesPaid } from "./notes";
import type { PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { chargeServices, lockPaymentBasis } from "./services";

export async function afterServicesPaid(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, links?: LinkBuilder): Promise<{ captures: PaymentOperation[]; holds: PaymentOperation[] }> {
  const captures = await chargeServices(db, paypal, sessionId, key);
  let holds: PaymentOperation[] = [];
  // Without a saved method, or with a blocked plan, the furniture waits: the item holds section shows why and offers each hold by hand.
  try { holds = await holdApprovedItems(db, paypal, sessionId, key, links); }
  catch (error) { if (!(error instanceof PaymentActionError)) throw error; }
  const paid = await db.transaction(async (tx) => (await lockPaymentBasis(tx, sessionId, key)).ledger.operations
    .filter((entry) => entry.servicesHold && entry.status === "succeeded").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]);
  if (paid) await noteServicesPaid(db, paid, holds);
  return { captures, holds };
}
