import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { createChatStore } from "../chat/store";
import { paymentOperations, paypalAuthorizations, paypalCaptures, paypalRefunds, supplierEvents } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { startCapture, startRelease } from "./actions";
import { executeCapture, requestCapture } from "./capture";
import { recordSupplierOrder } from "./supplier";
import { bergmund, confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { authorizeLine, CHAIR } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";
import { clientSignatureName } from "../opening/types";

describe.skipIf(!testDatabaseUrl)("cancelling an uncaptured line releases its hold", () => {
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
    await authorizeLine(handle.db, paypal, session, v2, "proposed");
  });
  afterAll(() => handle?.pool.end());

  const cancelChairs = () => confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "not_ordered", oldItemCostCents: 0 });
  const release = (order: FrozenChangeOrder) => startRelease(handle.db, paypal, session, order.id, { itemId: CHAIR, side: "baseline", ...shown(order) });
  const chairIn = async (order: FrozenChangeOrder, side: "baseline" | "proposed" = "baseline") => (await paymentsWorkspace(handle.db, session, order.id, undefined, DEMO_ACCOUNTS[0]))!.lines.find((line) => line.itemId === CHAIR && line.side === side)!;

  it("voids the $543.75 hold once the client confirms the cancelling version, refunding nothing", async () => {
    const v3 = await cancelChairs();
    const before = await chairIn(v3);
    expect(before).toMatchObject({ change: "remove", targetCents: 0, heldCents: 54_375, capturedCents: 0, steps: [expect.objectContaining({ kind: "void", amountCents: 54_375, available: true })] });

    const [voided] = await release(v3);
    expect(voided).toMatchObject({ kind: "void", status: "succeeded", amountCents: 54_375, changeOrderId: v3.id });
    const after = await chairIn(v3);
    expect(after).toMatchObject({ heldCents: 0, releasedCents: 54_375, capturedCents: 0, refundedCents: 0, steps: [], holds: [expect.objectContaining({ status: "voided", releasedCents: 54_375 })] });
    expect(await handle.db.select().from(paypalRefunds)).toHaveLength(0);
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.at(-1)?.text).toMatch(/released the hold .*not a refund/);

    // Releasing again finds the same void; capturing the voided hold is refused.
    expect((await release(v3)).map((operation) => operation.id)).toEqual([voided.id]);
    const [hold] = await handle.db.select().from(paypalAuthorizations);
    await expect(requestCapture(handle.db, { businessKey: "test:late-capture", projectId: hold.projectId, authorizationId: hold.id, amountCents: 1_000 })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/closed/) });
  });

  it("does not cancel anything when the client only requests changes to the cancelling version", async () => {
    const proposal = await confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "not_ordered", oldItemCostCents: 0 }, false);
    const { createApprovalStore } = await import("../approval/store");
    await createApprovalStore(handle.db).decide(session, proposal.id, { decision: "changes_requested", contentHash: proposal.contentHash, revisionContentHash: proposal.revisionContentHash, acknowledged: true, signature: clientSignatureName(proposal), note: "Keep the chairs after all." });
    await expect(release(proposal)).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
    expect((await chairIn(v2, "proposed")).heldCents).toBe(54_375);
  });

  it("captures only the confirmed $25 cancellation cost and closes the hold to release $518.75, once", async () => {
    const v3 = await confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "cancelled", oldItemCostCents: 2_500 });
    const input = { itemId: CHAIR, side: "baseline" as const, ...shown(v3) };
    expect(await chairIn(v3)).toMatchObject({ targetCents: 2_500, heldCents: 54_375, capturedCents: 0 });
    await expect(startCapture(handle.db, paypal, session, v3.id, input)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    const confirmation = { ...input, quantity: 1, unitPriceCents: 2_500, taxCents: 0, freightCents: 0, inStock: true, leadTimeDays: null, reference: "DEMO-CANCELLATION-COST-1", note: "Supplier confirmed the client-approved total cancellation cost." };
    const event = await recordSupplierOrder(handle.db, session, v3.id, confirmation);
    expect(event).toMatchObject({ kind: "order_confirmed", quantity: 1, unitPriceCents: 2_500, totalCents: 2_500, changeOrderId: v3.id, isDemo: true });
    expect((await recordSupplierOrder(handle.db, session, v3.id, confirmation)).id).toBe(event.id);
    expect(await handle.db.select().from(supplierEvents)).toHaveLength(1);

    const [captured] = await startCapture(handle.db, paypal, session, v3.id, input);
    expect(captured).toMatchObject({ status: "succeeded", amountCents: 2_500, finalCapture: true, supplierEventId: event.id, changeOrderId: v3.id });
    expect(await chairIn(v3)).toMatchObject({ targetCents: 2_500, capturedCents: 2_500, heldCents: 0, releasedCents: 51_875, refundedCents: 0, steps: [] });
    expect((await handle.db.select().from(paypalCaptures))).toEqual([expect.objectContaining({ amountCents: 2_500, finalCapture: true, status: "completed" })]);
    expect((await handle.db.select().from(paypalAuthorizations))[0].status).toBe("captured");
    expect(await handle.db.select().from(paypalRefunds)).toHaveLength(0);

    expect((await startCapture(handle.db, paypal, session, v3.id, input)).map((operation) => operation.id)).toEqual([captured.id]);
    expect(paypal.calls.filter((call) => "finalCapture" in call)).toHaveLength(1);
    expect((await handle.db.select().from(paymentOperations)).filter((operation) => operation.kind === "void")).toHaveLength(0);
  });

  it("refuses cancellation-cost terms that do not match the frozen fee and keeps the whole authorization untouched", async () => {
    const v3 = await confirmChange(handle.db, session, "willow", { action: "remove", itemId: CHAIR, oldItemHandling: "cancelled", oldItemCostCents: 2_500 });
    const input = { itemId: CHAIR, side: "baseline" as const, ...shown(v3) };
    const confirmation = { ...input, quantity: 1, unitPriceCents: 2_500, taxCents: 0, freightCents: 0, inStock: true, leadTimeDays: null, reference: "DEMO-CANCELLATION-COST-1", note: "Reviewed cancellation cost." };
    await expect(recordSupplierOrder(handle.db, session, v3.id, { ...confirmation, unitPriceCents: 2_600 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED" });
    await expect(recordSupplierOrder(handle.db, session, v3.id, { ...confirmation, quantity: 4 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED" });
    await expect(recordSupplierOrder(handle.db, session, v3.id, { ...confirmation, taxCents: 100 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED" });
    await expect(recordSupplierOrder(handle.db, session, v3.id, { ...confirmation, inStock: false })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/retained cost/) });
    await expect(recordSupplierOrder(handle.db, randomUUID(), v3.id, confirmation)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await handle.db.select().from(supplierEvents)).toHaveLength(0);
    await expect(startCapture(handle.db, paypal, session, v3.id, input)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(release(v3)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    expect(await chairIn(v3)).toMatchObject({ heldCents: 54_375, capturedCents: 0, releasedCents: 0 });
    expect(paypal.calls.filter((call) => "finalCapture" in call || "paypalAuthorizationId" in call)).toHaveLength(0);
  });

  it("keeps an already captured part on record and releases only the uncaptured rest", async () => {
    const [hold] = await handle.db.select().from(paypalAuthorizations);
    // A partial capture taken earlier on this hold (outside this change's flow).
    await executeCapture(handle.db, paypal, (await requestCapture(handle.db, { businessKey: "test:partial", projectId: hold.projectId, authorizationId: hold.id, amountCents: 20_000 })).id);
    const v3 = await cancelChairs();
    const line = await chairIn(v3);
    expect(line.steps.map((step) => [step.kind, step.amountCents])).toEqual(expect.arrayContaining([["void", 34_375], ["refund", 20_000]]));
    const [voided] = await release(v3);
    expect(voided.amountCents).toBe(34_375);
    expect(await chairIn(v3)).toMatchObject({ capturedCents: 20_000, releasedCents: 34_375, heldCents: 0 });
    expect((await handle.db.select().from(paypalCaptures))[0]).toMatchObject({ amountCents: 20_000, status: "completed" });
  });

  it("takes one explainable path when the void outcome is unknown: it is reconciled, never replaced or followed by a capture", async () => {
    const v3 = await cancelChairs();
    paypal.then("lose-response");
    const [lost] = await release(v3);
    expect(lost.status).toBe("unknown");
    expect((await paymentsWorkspace(handle.db, session, v3.id))!.plan?.status).toBe("blocked");
    await expect(startCapture(handle.db, paypal, session, v3.id, { itemId: CHAIR, side: "baseline", ...shown(v3) })).rejects.toMatchObject({ code: "PLAN_BLOCKED" });

    const [retried] = await release(v3);
    expect(retried).toMatchObject({ id: lost.id, status: "succeeded" });
    expect((await handle.db.select().from(paymentOperations)).filter((operation) => operation.kind === "void")).toHaveLength(1);
    expect((await chairIn(v3)).releasedCents).toBe(54_375);
  });
});
