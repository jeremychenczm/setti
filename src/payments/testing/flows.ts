/**
 * Test flows on top of the change fixture: the client approves a hold on the
 * fake PayPal, the designer records a supplier confirmation on the confirmed
 * terms, and the demo chairs reach "six chairs fully held".
 */
import type { Db } from "../../db/client";
import type { FrozenChangeOrder } from "../../pricing/types";
import { returnFromPayPal, startAuthorization } from "../actions";
import { recordSupplierOrder } from "../supplier";
import { bergmund, confirmChange, shown } from "./cases";
import type { FakePayPal } from "./fake-paypal";

export const CHAIR = "willow-lisabo-dining-chair";
export const links = (operationId: string) => ({ returnUrl: `http://localhost:3002/api/payments/paypal/return?op=${operationId}`, cancelUrl: `http://localhost:3002/api/payments/paypal/cancel?op=${operationId}` });

/** The client authorizes what the line still needs and approves it on (fake) PayPal. */
export async function authorizeLine(db: Db, paypal: FakePayPal, session: string, order: FrozenChangeOrder, side: "baseline" | "proposed") {
  const checkout = await startAuthorization(db, paypal, session, order.id, { itemId: CHAIR, side, ...shown(order) }, links);
  paypal.approve(checkout.paypalOrderId!);
  const back = await returnFromPayPal(db, paypal, checkout.id, checkout.paypalOrderId, "return");
  if (back?.state !== "authorized") throw new Error(`Authorization did not complete: ${back?.state}`);
  return checkout;
}

/** The designer records the supplier's confirmation of exactly the confirmed line (optionally with other terms). */
export function confirmSupplier(db: Db, session: string, order: FrozenChangeOrder, side: "baseline" | "proposed", terms: Partial<{ quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean }> = {}) {
  const line = order.lines.find((entry) => entry.itemId === CHAIR)!;
  return recordSupplierOrder(db, session, order.id, {
    itemId: CHAIR, side, ...shown(order),
    quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents, inStock: true,
    leadTimeDays: 14, reference: "DEMO-SUPPLIER-CONFIRMATION-1", note: "Demo supplier confirmation entered by the designer.", ...terms,
  });
}

/** V2 replaces the chairs with four BERGMUND ($543.75 held), V3 makes it six ($271.88 more held). */
export async function sixChairsHeld(db: Db, paypal: FakePayPal, session: string) {
  const v2 = await confirmChange(db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
  await authorizeLine(db, paypal, session, v2, "proposed");
  const v3 = await confirmChange(db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
  await authorizeLine(db, paypal, session, v3, "baseline");
  return { v2, v3 };
}
