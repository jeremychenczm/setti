/**
 * What follows the client's confirmation of a version. First, every hold the
 * version no longer needs, with nothing left to charge from it, is released:
 * that only gives the client's money back, and the client just signed for it.
 * Then every new furniture item it needs is held with the payment method the
 * project has saved, and the client's message hands the next step to the
 * designer. Releasing first means the client's card never carries the old and
 * the new holds together. Smaller captures and refunds stay with the designer:
 * they depend on what the supplier confirms and credits.
 */
import { eq } from "drizzle-orm";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { changeOrders } from "../pricing/schema";
import { startRelease, type LinkBuilder } from "./actions";
import { confirmedPlan, lockConfirmedVersion, PaymentActionError } from "./binding";
import { holdApprovedItems } from "./item-holds";
import { noteVersionConfirmed } from "./notes";
import type { PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";

/** Releases every hold the confirmed version says to release now, with no capture or supplier step before it. */
export async function releaseUnneededHolds(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string): Promise<PaymentOperation[]> {
  const [row] = await db.select({ document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, orderId));
  if (!row) return [];
  const shown = { contentHash: row.document.contentHash, revisionContentHash: row.document.revisionContentHash };
  let lines: { itemId: string; side: "baseline" | "proposed" }[];
  try {
    lines = await db.transaction(async (tx) => {
      const { plan } = await confirmedPlan(tx, await lockConfirmedVersion(tx, sessionId, orderId, shown));
      return plan.actions.filter((action) => action.kind === "release_authorization" && action.timing === "on_payment_execution").map(({ itemId, side }) => ({ itemId, side }));
    });
  } catch (error) {
    if (error instanceof PaymentActionError) return [];
    throw error;
  }
  const released: PaymentOperation[] = [];
  // One line at a time: each release reads the plan the previous one left.
  for (const line of lines) {
    try { released.push(...await startRelease(db, paypal, sessionId, orderId, { ...line, ...shown })); }
    catch (error) { if (!(error instanceof PaymentActionError)) throw error; }
  }
  return released;
}

export async function afterVersionConfirmed(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, orderId: string, links?: LinkBuilder): Promise<PaymentOperation[]> {
  // Releases first, so the old and new holds are never placed together.
  await releaseUnneededHolds(db, paypal, sessionId, orderId);
  let holds: PaymentOperation[] = [];
  // Without a saved method, or with a blocked plan, the new items wait: the payments panel shows why and offers each hold by hand.
  try { holds = await holdApprovedItems(db, paypal, sessionId, key, links); }
  catch (error) { if (!(error instanceof PaymentActionError)) throw error; }
  await noteVersionConfirmed(db, orderId);
  return holds;
}
