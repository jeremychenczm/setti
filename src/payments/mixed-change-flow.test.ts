import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { changeOrderDecisions } from "../approval/schema";
import { createApprovalStore } from "../approval/store";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";
import { returnFromPayPal, startAuthorization, startCapture, startRefund, startRelease } from "./actions";
import { recordSupplierCredit, recordSupplierOrder } from "./supplier";
import { confirmChanges, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";
import { clientSignatureName } from "../opening/types";

/** Fixed supplier terms are test inputs, not claims about a real seller. */
function product(name: string, sku: string, unitPriceCents: number): Partial<PricingItem> {
  return {
    name, vendor: "Demo supplier", sku, specification: name,
    quantity: 1, unitLabel: "each", currency: "USD", unitPriceCents,
    taxCents: 0, freightCents: 0, returnable: true,
    returnPolicy: "Demo terms reviewed by the designer.",
  };
}

describe.skipIf(!testDatabaseUrl)("one confirmed change coordinates items in different money states", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let mixed: FrozenChangeOrder;

  const ref = (itemId: string, side: "baseline" | "proposed" = "baseline") => ({ itemId, side });
  const workspace = () => paymentsWorkspace(handle.db, session, mixed.id);
  const line = async (itemId: string, side: "baseline" | "proposed" = "baseline") => (await workspace())!.lines.find((entry) => entry.itemId === itemId && entry.side === side)!;
  const releaseChair = () => startRelease(handle.db, paypal, session, mixed.id, { ...ref("chair"), ...shown(mixed) });
  const refundRug = () => startRefund(handle.db, paypal, session, mixed.id, { ...ref("rug"), ...shown(mixed) });
  const captureDesk = () => startCapture(handle.db, paypal, session, mixed.id, { ...ref("chair", "proposed"), ...shown(mixed) });
  const creditRug = () => recordSupplierCredit(handle.db, session, mixed.id, {
    ...ref("rug"), ...shown(mixed), creditCents: 24_000,
    reference: "DEMO-RUG-CREDIT", note: "Demo return credit, net of the frozen $60 cost.",
  });
  const supplier = (order: FrozenChangeOrder, itemId: string) => {
    const current = order.lines.find((entry) => entry.itemId === itemId)!;
    return recordSupplierOrder(handle.db, session, order.id, {
      ...ref(itemId, "proposed"), ...shown(order), quantity: current.quantity,
      unitPriceCents: current.unitPriceCents, taxCents: current.taxCents, freightCents: current.freightCents,
      inStock: true, leadTimeDays: 14, reference: `DEMO-ORDER-${itemId}`, note: "Demo confirmation entered by designer.",
    });
  };
  async function authorize(order: FrozenChangeOrder, itemId: string) {
    const checkout = await startAuthorization(handle.db, paypal, session, order.id, { ...ref(itemId, "proposed"), ...shown(order) }, links);
    paypal.approve(checkout.paypalOrderId!);
    expect(await returnFromPayPal(handle.db, paypal, checkout.id, checkout.paypalOrderId, "return")).toMatchObject({ state: "authorized" });
    return checkout;
  }

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    // A real domain fixture, not injected ledger rows: two approved products,
    // one held and the other captured. The unchanged $400 design fee remains
    // outside this mixed change's payment scope and is never claimed as paid.
    const initial = await confirmChanges(handle.db, session, "maple", [
      { action: "replace", itemId: "chair", after: product("Confirmed lounge chair", "DEMO-CHAIR-2", 80_000) },
      { action: "replace", itemId: "rug", after: product("Confirmed wool rug", "DEMO-RUG-2", 30_000) },
    ]);
    await authorize(initial, "chair");
    await authorize(initial, "rug");
    await supplier(initial, "rug");
    await startCapture(handle.db, paypal, session, initial.id, { ...ref("rug", "proposed"), ...shown(initial) });

    mixed = await confirmChanges(handle.db, session, "maple", [
      { action: "replace", itemId: "chair", after: product("Oak writing desk", "DEMO-DESK-1", 110_000), oldItemHandling: "not_ordered", oldItemCostCents: 0 },
      { action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000 },
    ]);
  });
  afterAll(() => handle?.pool.end());

  it("freezes two changes under one approval and allocates three distinct money groups", async () => {
    expect(mixed.changes.map((change) => [change.itemId, change.action])).toEqual([["chair", "replace"], ["rug", "remove"]]);
    expect(mixed.totals.totalCents).toBe(156_000);
    expect(mixed.deltaTotalCents).toBe(6_000);
    const decisions = await handle.db.select().from(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, mixed.id));
    expect(decisions).toEqual([expect.objectContaining({ decision: "approved", revisionId: mixed.revisionId, contentHash: mixed.contentHash, revisionContentHash: mixed.revisionContentHash })]);
    const view = (await workspace())!;
    expect(view.plan?.status).toBe("preview");
    expect(view.others).toEqual({ lineCount: 1, targetCents: 40_000 });
    expect(view.lines.map((entry) => [entry.itemId, entry.side, entry.heldCents, entry.capturedCents, entry.targetCents])).toEqual([
      ["chair", "baseline", 80_000, 0, 0],
      ["chair", "proposed", 0, 0, 110_000],
      ["rug", "baseline", 0, 30_000, 6_000],
    ]);
    expect(view.plan?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: "chair", side: "baseline", kind: "release_authorization", amountCents: 80_000, timing: "on_payment_execution" }),
      expect.objectContaining({ itemId: "chair", side: "proposed", kind: "new_authorization", amountCents: 110_000 }),
      expect.objectContaining({ itemId: "rug", side: "baseline", kind: "refund", amountCents: 24_000, timing: "after_vendor_credit" }),
    ]));
    const oldHold = (await line("chair")).holds[0];
    const rugHold = (await line("rug")).holds[0];
    expect(new Set(view.lines.map((entry) => entry.businessItemId)).size).toBe(3);
    expect((await line("rug")).refundRequiresSupplierCredit).toBe(true);
    expect(oldHold.id).not.toBe(rugHold.id);
    expect((await line("chair", "proposed")).holds).toEqual([]);
    await expect(startRefund(handle.db, paypal, session, mixed.id, { ...ref("chair", "proposed"), ...shown(mixed) })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("releases the old chair and completes the desk while the rug independently waits for its credit", async () => {
    const [released] = await releaseChair();
    expect(released).toMatchObject({ changeOrderId: mixed.id, revisionId: mixed.revisionId, contentHash: mixed.contentHash, amountCents: 80_000, kind: "void", status: "succeeded" });
    expect(await line("chair")).toMatchObject({ heldCents: 0, releasedCents: 80_000, capturedCents: 0, refundedCents: 0 });
    expect(await line("rug")).toMatchObject({ capturedCents: 30_000, refundedCents: 0 });
    await expect(refundRug()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    const checkout = await authorize(mixed, "chair");
    expect(checkout).toMatchObject({ changeOrderId: mixed.id, revisionId: mixed.revisionId, amountCents: 110_000 });
    expect((await workspace())!.operations.find((entry) => entry.id === checkout.id)?.businessItemId).toBe((await line("chair", "proposed")).businessItemId);
    expect(checkout.itemId).not.toBe(released.itemId);
    await expect(captureDesk()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await supplier(mixed, "chair");
    const [captured] = await captureDesk();
    expect(captured).toMatchObject({ changeOrderId: mixed.id, revisionId: mixed.revisionId, itemId: checkout.itemId, amountCents: 110_000, status: "succeeded" });
    expect(await line("chair", "proposed")).toMatchObject({ heldCents: 0, capturedCents: 110_000, refundedCents: 0, steps: [] });
    // Confirming the new desk never grants a credit to the returned rug.
    expect(await line("rug")).toMatchObject({ capturedCents: 30_000, refundedCents: 0, supplierEvents: [] });
    await expect(refundRug()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    const credit = await creditRug();
    const [refunded] = await refundRug();
    expect(refunded).toMatchObject({ changeOrderId: mixed.id, revisionId: mixed.revisionId, amountCents: 24_000, status: "succeeded", supplierEventId: credit.id });
    expect(refunded.itemId).not.toBe(checkout.itemId);
    expect(await line("rug")).toMatchObject({ capturedCents: 30_000, refundedCents: 24_000, targetCents: 6_000, steps: [] });
    expect(await line("chair", "proposed")).toMatchObject({ capturedCents: 110_000, refundedCents: 0 });

    const calls = paypal.calls.length;
    expect((await releaseChair())[0].id).toBe(released.id);
    expect((await captureDesk())[0].id).toBe(captured.id);
    expect((await refundRug())[0].id).toBe(refunded.id);
    expect(paypal.calls).toHaveLength(calls);
  });

  it("a rug credit cannot unlock the desk, and the common approved version gates every item", async () => {
    await authorize(mixed, "chair");
    await creditRug();
    await expect(captureDesk()).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await refundRug();
    expect(await line("chair", "proposed")).toMatchObject({ heldCents: 110_000, capturedCents: 0, supplierEvents: [] });
    expect(await line("chair")).toMatchObject({ heldCents: 80_000, releasedCents: 0 });
    await expect(recordSupplierCredit(handle.db, session, mixed.id, { ...ref("chair", "proposed"), ...shown(mixed), creditCents: 24_000, reference: "WRONG-LINE", note: "" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    // A fresh proposal is not approved: the old version still owns all money.
    const unapproved = await confirmChanges(handle.db, session, "maple", [
      { action: "quantity", itemId: "chair", quantity: 2, after: { unitPriceCents: 110_000 } },
    ], false);
    await expect(startCapture(handle.db, paypal, session, unapproved.id, { ...ref("chair"), ...shown(unapproved) })).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    await createApprovalStore(handle.db).decide(session, unapproved.id, { decision: "approved", ...shown(unapproved), acknowledged: true, signature: clientSignatureName(unapproved), note: "" });
    await expect(releaseChair()).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(await line("chair")).toMatchObject({ heldCents: 80_000, releasedCents: 0 });
  });

  it("retains per-item return conditions and operation identities while another checkout blocks execution", async () => {
    const checkout = await startAuthorization(handle.db, paypal, session, mixed.id, { ...ref("chair", "proposed"), ...shown(mixed) }, links);
    const view = (await workspace())!;
    expect(view.plan?.status).toBe("blocked");
    const rug = view.lines.find((entry) => entry.itemId === "rug")!;
    const oldChair = view.lines.find((entry) => entry.itemId === "chair" && entry.side === "baseline")!;
    const desk = view.lines.find((entry) => entry.itemId === "chair" && entry.side === "proposed")!;
    expect(rug.steps).toEqual([]);
    expect(rug.refundRequiresSupplierCredit).toBe(true);
    expect(rug.supplierEvents).toEqual([]);
    expect(view.operations.find((entry) => entry.id === checkout.id)).toMatchObject({ businessItemId: desk.businessItemId, status: "pending" });
    expect(desk.businessItemId).not.toBe(oldChair.businessItemId);
    expect(desk.businessItemId).not.toBe(rug.businessItemId);
  });
});
