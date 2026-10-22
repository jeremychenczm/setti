/**
 * Test fixture: runs the real chat, draft, pricing review, issue and client
 * confirmation flow for one change, with a fixed draft instead of a model call.
 * Payment tests start from the same frozen versions, hashes and business items
 * the app creates.
 */
import type { CaseKey } from "../../chat/types";
import type { Db } from "../../db/client";
import type { FrozenChangeOrder, PricingItem } from "../../pricing/types";
import { confirmScriptedChanges, type ScriptedChange } from "../../try/scripted-change";

export { shown } from "../../try/scripted-change";
export type TestChange = ScriptedChange;

/** The demo chair replacement: four BERGMUND chairs at $125 with $43.75 recorded tax ($543.75). */
export const bergmund = (quantity = 4, taxCents = 4_375): Partial<PricingItem> => ({
  name: "BERGMUND Chair - oak effect/Orrsta light gray", vendor: "IKEA", brand: "IKEA", sku: "794.717.09",
  specification: "BERGMUND Chair - oak effect/Orrsta light gray", unitLabel: "item", currency: "USD",
  quantity, unitPriceCents: 12_500, taxCents, freightCents: 0,
  sourceUrl: "https://www.ikea.com/us/en/p/bergmund-chair-oak-effect-orrsta-light-gray-s79471709/",
  returnPolicy: "Demo terms: returnable subject to the seller's policy.", returnable: true,
});

/** Issues one reviewed change for the session's case and, unless `confirm` is false, confirms it as the demo client. */
export function confirmChange(db: Db, session: string, key: CaseKey, change: TestChange, confirm = true): Promise<FrozenChangeOrder> {
  return confirmChanges(db, session, key, [change], confirm);
}

/** Several changes share one draft, frozen document, approval and set of version hashes. */
export function confirmChanges(db: Db, session: string, key: CaseKey, changes: TestChange[], confirm = true): Promise<FrozenChangeOrder> {
  return confirmScriptedChanges(db, session, key, changes, { confirm });
}
