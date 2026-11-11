import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { itemCancellations, paymentOperations, paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, CONSULTATION, DESK, DESK_CENTS, SOFA, TEST_KEY, testClient as client, testDesigner as designer, testLine, testQuote } from "../projects/testing";
import { startOpeningCapture } from "./actions";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { cancellationMessage } from "./cancellation";
import { holdApprovedItems } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { lockOpeningVersion } from "./opening";
import { insertOperation } from "./operations";
import { paymentsWorkspace } from "./workspace";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { bergmund, confirmChange } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";

const desk = testLine(DESK);
const deskTotal = DESK_CENTS; // $250.00 + $20.00 tax
/** The database's own refusal, wherever the driver puts its message. */
const databaseRefused = (pattern: RegExp) => (error: unknown) => {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
  return messages.some((message) => pattern.test(message));
};

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
    await addTestProject(handle.db, session);
    await signOpeningForTest(handle.db, session, TEST_KEY, testQuote.lines.map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
    await holdApprovedItems(handle.db, paypal, session, TEST_KEY);
  });
  afterAll(() => handle?.pool.end());

  const cancel = (input: Partial<Parameters<typeof cancelApprovedItem>[4]> = {}) => cancelApprovedItem(handle.db, paypal, session, TEST_KEY, {
    itemId: DESK, reason: "unavailable", note: "The walnut finish was discontinued.", by: designer.name, ...input,
  });
  const view = (account = designer) => itemHoldsView(handle.db, session, TEST_KEY, account);
  const deskLine = async (account = designer) => (await view(account)).items.find((line) => line.itemId === DESK)!;
  const chat = async () => (await createChatStore(handle.db).getCase(session, TEST_KEY)).messages;
  const messages = async () => (await chat()).map((message) => message.text);
  const fromDesigner = async () => (await chat()).filter((message) => message.actor === "designer" && message.text.startsWith("Update on Writing desk")).map((message) => message.text);
  const version = () => handle.db.transaction((tx) => lockOpeningVersion(tx, session, TEST_KEY, null));
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
    expect(await holdApprovedItems(handle.db, paypal, session, TEST_KEY)).toEqual([]);
    expect((await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, await deskItemId())).orderBy(paymentOperations.createdAt)).map((operation) => operation.kind)).toEqual(["authorize", "void"]);

    const text = await messages();
    // The client hears it from the designer, as a chat message of its own.
    expect(await fromDesigner()).toEqual([
      `Update on Writing desk: I've cancelled it because the supplier can't supply it. The walnut finish was discontinued. Nothing was charged for it, and its $270.00 hold is being released on PayPal. If you'd like a replacement, I'll send it to you as a new version to confirm.`,
    ]);
    expect(await fromDesigner()).toEqual([cancellationMessage({ itemName: "Writing desk", reason: "unavailable", note: "The walnut finish was discontinued.", heldCents: deskTotal })]);
    expect(text.at(-1)).toMatch(/released the hold for V1 · Writing desk/);

    // Repeating the step changes nothing and writes nothing new.
    expect(await cancel({ reason: "other", note: "A different story" })).toMatchObject({ cancellation: { id: cancellation.id, reason: "unavailable" }, operations: [] });
    expect((await messages()).length).toBe(text.length);
  });

  it("refuses supplier confirmations, captures and new holds once the item is cancelled", async () => {
    await cancel();
    const { contentHash } = await version();
    await expect(recordOpeningSupplierOrder(handle.db, session, TEST_KEY, {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "BD-SO-1001", note: "",
    })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(startOpeningCapture(handle.db, paypal, session, TEST_KEY, { itemId: DESK, contentHash })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
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
    await recordOpeningSupplierOrder(handle.db, session, TEST_KEY, {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "BD-SO-1001", note: "",
    });
    expect(await deskLine()).toMatchObject({ state: "confirmed", canCancelItem: true });
    expect((await cancel({ reason: "client_asked", note: "" })).operations).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(await deskLine()).toMatchObject({ state: "cancelled", heldCents: 0 });
  });

  it("does not cancel an item that was already charged", async () => {
    const { contentHash } = await version();
    await recordOpeningSupplierOrder(handle.db, session, TEST_KEY, {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "BD-SO-1001", note: "",
    });
    await startOpeningCapture(handle.db, paypal, session, TEST_KEY, { itemId: DESK, contentHash });
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
    expect(await fromDesigner()).toHaveLength(1);
  });

  it("keeps a cancelled item unfunded in the versions that follow", async () => {
    await cancel();
    const itemId = await deskItemId();
    const order = await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() });
    const holds = await view();
    expect(holds.basis).toMatchObject({ version: order.version, orderId: order.id });
    expect(holds.items.find((line) => line.itemId === DESK)).toMatchObject({ state: "cancelled", heldCents: 0, canCancelItem: false, cancellation: { reason: "unavailable" } });
    await holdApprovedItems(handle.db, paypal, session, TEST_KEY);
    expect((await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, itemId)).orderBy(paymentOperations.createdAt)).map((operation) => operation.kind)).toEqual(["authorize", "void"]);
  });

  it("cancels an item from a later version's payments page too", async () => {
    const order = await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() });
    const deskOf = async (account = designer) => (await paymentsWorkspace(handle.db, session, order.id, new Date(), account))!.lines.find((line) => line.itemId === DESK)!;
    expect(await deskOf()).toMatchObject({ heldCents: deskTotal, canCancelItem: true, cancellation: null });
    expect(await deskOf(client)).toMatchObject({ canCancelItem: false });

    const { operations } = await cancel({ reason: "no_response", note: "" });
    expect(operations).toEqual([expect.objectContaining({ kind: "void", status: "succeeded", changeOrderId: order.id, amountCents: deskTotal })]);
    expect(await deskOf()).toMatchObject({ targetCents: 0, cancelledTargetCents: deskTotal, heldCents: 0, canCancelItem: false, cancellation: { reason: "no_response", by: designer.name } });
    expect(await fromDesigner()).toEqual([expect.stringMatching(/^Update on Writing desk: I've cancelled it because the supplier never confirmed the order\. Nothing was charged/)]);
  });

  it("only cancels an approved furniture item of the current agreement", async () => {
    await expect(cancel({ itemId: SOFA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancel({ itemId: CONSULTATION })).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NOT_AVAILABLE/) });
  });
});
