/**
 * What follows the client's confirmation of a version: every new furniture item
 * it needs is held with the payment method the project has saved, and the
 * client's message hands the next step to the designer. Releases, smaller
 * captures and refunds stay with the designer: they depend on what was ordered
 * and on supplier credits.
 */
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { LinkBuilder } from "./actions";
import { PaymentActionError } from "./binding";
import { holdApprovedItems } from "./item-holds";
import { noteVersionConfirmed } from "./notes";
import type { PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";

export async function afterVersionConfirmed(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, orderId: string, links?: LinkBuilder): Promise<PaymentOperation[]> {
  let holds: PaymentOperation[] = [];
  // Without a saved method, or with a blocked plan, the new items wait: the payments panel shows why and offers each hold by hand.
  try { holds = await holdApprovedItems(db, paypal, sessionId, key, links); }
  catch (error) { if (!(error instanceof PaymentActionError)) throw error; }
  await noteVersionConfirmed(db, orderId, holds);
  return holds;
}
