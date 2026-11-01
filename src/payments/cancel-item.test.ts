import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { createChatStore } from "../chat/store";
import { itemCancellations, paymentOperations, paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { startOpeningCapture } from "./actions";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { holdApprovedItems } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { lockOpeningVersion } from "./opening";
import { insertOperation } from "./operations";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { bergmund, confirmChange } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";

const [designer, client] = DEMO_ACCOUNTS;
const DESK = "willow-desk", SOFA = "willow-sofa";
const desk = caseDocument("willow").lines.find((line) => line.itemId === DESK)!;
const deskTotal = desk.quantity * desk.unitPriceCents + desk.taxCents + desk.freightCents;
/** The database's own refusal, wherever the driver puts its message. */
const databaseRefused = (pattern: RegExp) => (error: unknown) => {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
  return messages.some((message) => pattern.test(message));
};
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

describe.skipIf(!testDatabaseUrl)("the studio cancels an approved item", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    // Every line approved except the sofa, then the services paid and the items held.
    await signOpeningForTest(handle.db, session, "willow", caseDocument("willow").lines.map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, "willow");
    await holdApprovedItems(handle.db, paypal, session, "willow");
  });
  afterAll(() => handle?.pool.end());

  const cancel = (input: Partial<Parameters<typeof cancelApprovedItem>[4]> = {}) => cancelApprovedItem(handle.db, paypal, session, "willow", {
    itemId: DESK, reason: "unavailable", note: "The walnut finish was discontinued.", by: designer.name, ...input,
  });
  const view = (account = designer) => itemHoldsView(handle.db, session, "willow", account);
  const deskLine = async (account = designer) => (await view(account)).items.find((line) => line.itemId === DESK)!;
  const messages = async () => (await createChatStore(handle.db).getCase(session, "willow")).messages.map((message) => message.text);
  const version = () => handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
  const deskItemId = async () => (await version()).approved.find((entry) => entry.line.itemId === DESK)!.itemId;

  it("releases the held item with a reason, tells the client, and never holds it again", async () => {
    expect(await deskLine()).toMatchObject({ state: "held", heldCents: deskTotal, canCancelItem: true, cancellation: null });
    expect(await deskLine(client)).toMatchObject({ canCancelItem: false });
    const before = await view();

    const { cancellation, operations } = await cancel();
    expect(cancellation).toMatchObject({ reason: "unavailable", note: "The walnut finish was discontinued.", cancelledBy: designer.name, changeOrderId: null });
    expect(operations).toEqual([expect.objectContaining({ kind: "void", status: "succeeded", amountCents: deskTotal, changeOrderId: null })]);
    const [hold] = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, operations[0].authorizationId!));
    expect(hold.status).toBe("voided");

    const after = await view();
    expect(after.items.find((line) => line.itemId === DESK)).toMatchObject({
      state: "cancelled", heldCents: 0, capturedCents: 0, targetCents: deskTotal, canCancelItem: false,
      cancellation: { reason: "unavailable", reasonText: "Out of stock or discontinued", note: "The walnut finish was discontinued.", by: designer.name },
    });
    expect(after.toHoldCents).toBe(before.toHoldCents);
    expect(await holdApprovedItems(handle.db, paypal, session, "willow")).toEqual([]);
    expect((await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, await deskItemId()))).map((operation) => operation.kind)).toEqual(["authorize", "void"]);

    const text = await messages();
    expect(text.filter((message) => message.includes("cancelled Writing desk"))).toEqual([
      `${designer.name} cancelled Writing desk from V1: Out of stock or discontinued (The walnut finish was discontinued.). Nothing was charged for it. Its ${usd(deskTotal)} hold is being released on PayPal, so the money stays with the client. A replacement would come as a new version for the client to confirm.`,
    ]);
    expect(text.at(-1)).toMatch(/released the hold for V1 · Writing desk/);

    // Repeating the step changes nothing and writes nothing new.
    expect(await cancel({ reason: "other", note: "A different story" })).toMatchObject({ cancellation: { id: cancellation.id, reason: "unavailable" }, operations: [] });
    expect((await messages()).length).toBe(text.length);
  });

  it("refuses supplier confirmations, captures and new holds once the item is cancelled", async () => {
    await cancel();
    const { contentHash } = await version();
    await expect(recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(startOpeningCapture(handle.db, paypal, session, "willow", { itemId: DESK, contentHash })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    // The database refuses a hold for it even when the application would ask.
    const opening = await version();
    const itemId = await deskItemId();
    await expect(insertOperation(handle.db, { businessKey: `test-hold:${randomUUID()}`, projectId: opening.projectId, kind: "authorize", amountCents: 100, binding: opening.bind(itemId) }))
      .rejects.toSatisfy(databaseRefused(/the studio cancelled this item/));
    // The record itself cannot be changed or removed.
    await expect(handle.db.update(itemCancellations).set({ note: "edited" }).where(eq(itemCancellations.itemId, itemId))).rejects.toSatisfy(databaseRefused(/recorded note cannot change/));
    await expect(handle.db.delete(itemCancellations).where(eq(itemCancellations.itemId, itemId))).rejects.toSatisfy(databaseRefused(/cannot be deleted/));
  });

  it("can cancel a supplier-confirmed item that was not captured yet", async () => {
    const { contentHash } = await version();
    await recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    });
    expect(await deskLine()).toMatchObject({ state: "confirmed", canCancelItem: true });
    expect((await cancel({ reason: "client_asked", note: "" })).operations).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(await deskLine()).toMatchObject({ state: "cancelled", heldCents: 0 });
  });

  it("does not cancel an item that was already charged", async () => {
    const { contentHash } = await version();
    await recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    });
    await startOpeningCapture(handle.db, paypal, session, "willow", { itemId: DESK, contentHash });
    expect(await deskLine()).toMatchObject({ state: "captured", canCancelItem: false });
    await expect(cancel()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/already charged/) });
    // The database refuses it too.
    const opening = await version();
    await expect(handle.db.insert(itemCancellations).values({ projectId: opening.projectId, itemId: await deskItemId(), revisionId: opening.revisionId, reason: "unavailable", cancelledBy: designer.name }))
      .rejects.toSatisfy(databaseRefused(/already charged/));
    expect(await handle.db.select().from(itemCancellations)).toHaveLength(0);
  });

  it("waits for an open PayPal step, and tries a refused release again", async () => {
    // The release is refused the first time; the item stays cancelled with its hold still open.
    paypal.then("reject-over-limit");
    const first = await cancel();
    expect(first.operations).toEqual([expect.objectContaining({ kind: "void", status: "failed" })]);
    expect(await deskLine()).toMatchObject({ state: "cancelled", heldCents: deskTotal, cancellation: { reason: "unavailable" } });
    const second = await cancel();
    expect(second.cancellation.id).toBe(first.cancellation.id);
    expect(second.operations).toEqual([expect.objectContaining({ kind: "void", status: "succeeded", amountCents: deskTotal })]);
    expect(second.operations[0].id).not.toBe(first.operations[0].id);
    expect(await deskLine()).toMatchObject({ state: "cancelled", heldCents: 0 });
    expect((await messages()).filter((message) => message.includes("cancelled Writing desk"))).toHaveLength(1);
  });

  it("keeps a cancelled item unfunded in the versions that follow", async () => {
    await cancel();
    const itemId = await deskItemId();
    const order = await confirmChange(handle.db, session, "willow", { action: "replace", itemId: CHAIR, after: bergmund() });
    const holds = await view();
    expect(holds.basis).toMatchObject({ version: order.version, orderId: order.id });
    expect(holds.items.find((line) => line.itemId === DESK)).toMatchObject({ state: "cancelled", heldCents: 0, canCancelItem: false, cancellation: { reason: "unavailable" } });
    await holdApprovedItems(handle.db, paypal, session, "willow");
    expect((await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, itemId))).map((operation) => operation.kind)).toEqual(["authorize", "void"]);
  });

  it("asks for the designer's own words when the reason is Other", async () => {
    await expect(cancel({ reason: "other", note: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await cancel({ reason: "other", note: "The client moved the study to the guest room." })).cancellation).toMatchObject({ reason: "other" });
    expect((await messages()).some((message) => message.includes("cancelled Writing desk from V1: The client moved the study to the guest room."))).toBe(true);
  });

  it("only cancels an approved furniture item of the current agreement", async () => {
    await expect(cancel({ itemId: SOFA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancel({ itemId: "willow-consultation" })).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NOT_AVAILABLE/) });
  });
});
