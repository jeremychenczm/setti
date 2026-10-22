import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { returnFromPayPal, startAuthorization } from "./actions";
import { bergmund, confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { paymentsWorkspace } from "./workspace";

const CHAIR = "willow-lisabo-dining-chair";
const links = (operationId: string) => ({ returnUrl: `http://localhost:3002/api/payments/paypal/return?op=${operationId}`, cancelUrl: `http://localhost:3002/api/payments/paypal/cancel?op=${operationId}` });

describe.skipIf(!testDatabaseUrl)("additional authorization after a confirmed change", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v2: FrozenChangeOrder;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    v2 = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    await authorize(v2, "proposed");
  });
  afterAll(() => handle?.pool.end());

  async function authorize(order: FrozenChangeOrder, side: "baseline" | "proposed") {
    const checkout = await startAuthorization(handle.db, paypal, session, order.id, { itemId: CHAIR, side, ...shown(order) }, links);
    paypal.approve(checkout.paypalOrderId!);
    expect(await returnFromPayPal(handle.db, paypal, checkout.id, checkout.paypalOrderId, "return")).toMatchObject({ state: "authorized" });
    return checkout;
  }
  const chairLine = async (order: FrozenChangeOrder) => (await paymentsWorkspace(handle.db, session, order.id))!.lines.find((line) => line.itemId === CHAIR && (line.side === "baseline" || line.change === "replace"))!;

  it("asks only for the $271.88 the confirmed six chairs still need, as a second independent hold", async () => {
    const six = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    expect(six).toMatchObject({ basedOnQuoteId: v2.id, basedOnVersion: v2.version });
    const before = await chairLine(six);
    expect(before).toMatchObject({ targetCents: 81_563, heldCents: 54_375, capturedCents: 0 });
    expect(before.steps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "authorize", amountCents: 27_188, available: true }), expect.objectContaining({ kind: "capture", amountCents: 54_375, available: false })]));

    const topUp = await authorize(six, "baseline");
    expect(topUp).toMatchObject({ amountCents: 27_188, changeOrderId: six.id });
    const holds = await handle.db.select().from(paypalAuthorizations);
    expect(holds.map((hold) => hold.amountCents).sort()).toEqual([27_188, 54_375]);
    expect(new Set(holds.map((hold) => hold.paypalAuthorizationId)).size).toBe(2);
    expect(new Set(holds.map((hold) => hold.itemId)).size).toBe(1);
    expect(holds.find((hold) => hold.amountCents === 54_375)?.changeOrderId).toBe(v2.id);

    const after = await chairLine(six);
    expect(after).toMatchObject({ targetCents: 81_563, heldCents: 81_563, capturedCents: 0, holds: [expect.objectContaining({ version: v2.version }), expect.objectContaining({ version: six.version })] });
    expect(after.steps.map((step) => [step.kind, step.amountCents, step.available])).toEqual([["supplier_confirmation", 81_563, true], ["capture", 81_563, false]]);
    await expect(startAuthorization(handle.db, paypal, session, six.id, { itemId: CHAIR, side: "baseline", ...shown(six) }, links)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("starts nothing at a newer version's amount until the client confirms it", async () => {
    const waiting = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } }, false);
    await expect(startAuthorization(handle.db, paypal, session, waiting.id, { itemId: CHAIR, side: "baseline", ...shown(waiting) }, links)).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    // The confirmed V2 is still fully held, so there is nothing to authorize there either.
    await expect(startAuthorization(handle.db, paypal, session, v2.id, { itemId: CHAIR, side: "proposed", ...shown(v2) }, links)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("recalculates from the full target when the original hold has expired", async () => {
    await handle.db.update(paypalAuthorizations).set({ status: "expired" }).where(eq(paypalAuthorizations.changeOrderId, v2.id));
    const six = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    const line = await chairLine(six);
    expect(line).toMatchObject({ heldCents: 0, releasedCents: 54_375 });
    expect(line.steps).toEqual([expect.objectContaining({ kind: "authorize", amountCents: 81_563, available: true })]);
  });

  it("never lets a replacement product use the old product's hold", async () => {
    const other = await confirmChange(handle.db, session, "willow", {
      action: "replace", itemId: CHAIR, oldItemHandling: "not_ordered",
      after: { ...bergmund(4, 4_375), name: "ODGER Chair", sku: "DEMO-ODGER", specification: "ODGER Chair, white/beige", sourceUrl: null },
    });
    const workspace = (await paymentsWorkspace(handle.db, session, other.id))!;
    const oldChair = workspace.lines.find((line) => line.itemId === CHAIR && line.side === "baseline")!;
    const newChair = workspace.lines.find((line) => line.itemId === CHAIR && line.side === "proposed")!;
    expect(oldChair).toMatchObject({ targetCents: 0, heldCents: 54_375, steps: [expect.objectContaining({ kind: "void", amountCents: 54_375 })] });
    expect(newChair).toMatchObject({ targetCents: 54_375, heldCents: 0, steps: [expect.objectContaining({ kind: "authorize", amountCents: 54_375, available: true })] });
  });
});
