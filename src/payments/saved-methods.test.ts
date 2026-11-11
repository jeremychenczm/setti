import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { savedPaymentMethodRemovals, savedPaymentMethods } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { addTestProject, TEST_KEY, testClient as client, testDesigner } from "../projects/testing";
import { returnFromPayPal, startAuthorization } from "./actions";
import { holdApprovedItems, startItemCheckout } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { insertOperation } from "./operations";
import type { SavedPayPalOrderCommand, TestCardApproval } from "./paypal";
import { activeSavedMethod, removeCaseSavedMethod } from "./saved-methods";
import { chargeServices, lockPaymentBasis, startServicesCheckout } from "./services";
import { servicesPaymentView } from "./services-view";
import { approveCheckoutWithTestCard } from "./test-card";
import { bergmund, confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";

describe.skipIf(!testDatabaseUrl)("saved payment methods: cards, consent and removal", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
  });
  afterAll(() => handle?.pool.end());

  const projectId = async () => (await handle.db.transaction((tx) => lockPaymentBasis(tx, session, TEST_KEY))).projectId;
  const active = async () => activeSavedMethod(handle.db, await projectId());
  const savedOrders = () => paypal.calls.filter((call): call is SavedPayPalOrderCommand => "paypalTokenId" in call);

  /** The client pays the approved V1 design services with the Sandbox test card. */
  async function payServicesWithTestCard(save: boolean, testCard: TestCardApproval = paypal.confirmWithTestCard) {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links, { save });
    const result = await approveCheckoutWithTestCard(handle.db, paypal, testCard, checkout);
    if (result.state === "authorized") await chargeServices(handle.db, paypal, session, TEST_KEY);
    return result;
  }

  async function approve(checkout: { id: string; paypalOrderId: string | null }) {
    paypal.approve(checkout.paypalOrderId!);
    expect(await returnFromPayPal(handle.db, paypal, checkout.id, checkout.paypalOrderId, "return")).toMatchObject({ state: "authorized" });
  }

  /** The client holds a confirmed change's line through checkout, agreeing to save PayPal. */
  async function holdThroughCheckout(order: FrozenChangeOrder, side: "baseline" | "proposed", itemId = CHAIR) {
    const checkout = await startAuthorization(handle.db, paypal, session, order.id, { itemId, side, ...shown(order) }, links, { save: true });
    await approve(checkout);
    return checkout;
  }

  it("saves the Sandbox test card with the design-services payment and holds items with it, no PayPal window", async () => {
    expect(await payServicesWithTestCard(true)).toMatchObject({ state: "authorized" });
    expect(await active()).toMatchObject({ kind: "card", label: "Visa •••• 0026" });
    expect(await servicesPaymentView(handle.db, session, TEST_KEY, client, "client-id")).toMatchObject({ dueCents: 0, savedMethod: { kind: "card", label: "Visa •••• 0026" }, canRemoveSaved: true });

    const holds = await holdApprovedItems(handle.db, paypal, session, TEST_KEY, links);
    expect(holds).toHaveLength(4);
    expect(holds.every((operation) => operation.status === "succeeded" && !operation.approvalUrl)).toBe(true);
    expect(savedOrders().every((call) => call.kind === "card")).toBe(true);
  });

  it("saves nothing when the client does not agree to save the method", async () => {
    expect(await payServicesWithTestCard(false)).toMatchObject({ state: "authorized" });
    expect(await active()).toBeNull();
    expect(await itemHoldsView(handle.db, session, TEST_KEY, client)).toMatchObject({ savedMethod: null, canHold: false });
  });

  it("authorizes an order the client already approved on PayPal without confirming it again with the card", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links, { save: true });
    paypal.approve(checkout.paypalOrderId!);
    let confirmations = 0;
    const counting: TestCardApproval = (orderId, options) => { confirmations += 1; return paypal.confirmWithTestCard(orderId, options); };
    expect(await approveCheckoutWithTestCard(handle.db, paypal, counting, checkout)).toMatchObject({ state: "authorized" });
    expect(confirmations).toBe(0);
    // Approved on PayPal, so PayPal (not the card) is what the project saved.
    expect(await active()).toMatchObject({ kind: "paypal", label: "b•••@personal.example.com" });
  });

  it("removes the method at PayPal first, then refuses every later hold with it", async () => {
    await payServicesWithTestCard(true);
    const method = (await active())!;
    await removeCaseSavedMethod(handle.db, paypal, session, TEST_KEY);
    expect(paypal.deletes).toEqual([method.paypalTokenId]);
    expect(await active()).toBeNull();
    expect(await itemHoldsView(handle.db, session, TEST_KEY, client)).toMatchObject({ savedMethod: null, canRemoveSaved: false });
    await expect(holdApprovedItems(handle.db, paypal, session, TEST_KEY, links)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    // The database also refuses a hold bound to the removed method, and keeps the removal as a record.
    const basis = await handle.db.transaction((tx) => lockPaymentBasis(tx, session, TEST_KEY));
    const action = basis.plan.actions.find((entry) => entry.kind === "new_authorization")!;
    const itemId = basis.businessItem(action)!;
    await expect(handle.db.transaction((tx) => insertOperation(tx, { businessKey: `removed:${itemId}`, projectId: basis.projectId, kind: "authorize", amountCents: action.amountCents, binding: basis.bind(itemId), savedMethodId: method.id })))
      .rejects.toMatchObject({ message: expect.stringMatching(/removed this saved payment method/) });
    await expect(handle.db.delete(savedPaymentMethodRemovals).where(eq(savedPaymentMethodRemovals.methodId, method.id)))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/cannot be deleted/) }) });
  });

  it("keeps the method when PayPal does not confirm the removal, and finishes it on a retry", async () => {
    await payServicesWithTestCard(true);
    const method = (await active())!;
    paypal.deletesUnavailable = true;
    await expect(removeCaseSavedMethod(handle.db, paypal, session, TEST_KEY)).rejects.toMatchObject({ code: "OPERATION_REFUSED" });
    expect(await active()).toMatchObject({ id: method.id });

    // The first delete may have reached PayPal after all; deleting again is accepted (probe P12), so the retry records the removal.
    paypal.deletesUnavailable = false;
    paypal.deletedTokens.add(method.paypalTokenId);
    await removeCaseSavedMethod(handle.db, paypal, session, TEST_KEY);
    expect(await active()).toBeNull();
    expect(paypal.deletes).toEqual([method.paypalTokenId, method.paypalTokenId]);
  });

  it("refuses to remove a method while a hold with it is still in progress", async () => {
    await payServicesWithTestCard(true);
    paypal.then("answer-payer-action");
    const holds = await holdApprovedItems(handle.db, paypal, session, TEST_KEY, links);
    expect(holds.some((operation) => operation.status === "pending")).toBe(true);
    await expect(removeCaseSavedMethod(handle.db, paypal, session, TEST_KEY)).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/still in progress/) });
    expect(paypal.deletes).toEqual([]);
  });

  it("keeps one active method per project and lets the client save a new one after removing it", async () => {
    const v2 = await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() });
    const first = await holdThroughCheckout(v2, "proposed");
    expect(await active()).toMatchObject({ kind: "paypal", sourceOperationId: first.id });

    // With a method active, a further checkout does not ask to save another one.
    const six = await confirmChange(handle.db, session, TEST_KEY, { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    expect((await holdThroughCheckout(six, "baseline")).savePaymentMethod).toBe(false);

    // After removing it, the next checkout asks again. Here PayPal authorizes it without saving anything.
    await removeCaseSavedMethod(handle.db, paypal, session, TEST_KEY);
    const seven = await confirmChange(handle.db, session, TEST_KEY, { action: "quantity", itemId: CHAIR, quantity: 7, after: { taxCents: 7_657 } });
    paypal.then("succeed", "answer-unsaved");
    const unsaved = await holdThroughCheckout(seven, "baseline");
    expect(unsaved.savePaymentMethod).toBe(true);
    expect(await active()).toBeNull();

    const eight = await confirmChange(handle.db, session, TEST_KEY, { action: "quantity", itemId: CHAIR, quantity: 8, after: { taxCents: 8_750 } });
    const again = await holdThroughCheckout(eight, "baseline");
    const second = (await active())!;
    expect(second).toMatchObject({ kind: "paypal", sourceOperationId: again.id });
    expect(await handle.db.select().from(savedPaymentMethods)).toHaveLength(2);

    // The unsaved checkout also asked to save and succeeded, but a second active method is refused by the database itself.
    await expect(handle.db.insert(savedPaymentMethods).values({ projectId: second.projectId, sourceOperationId: unsaved.id, paypalTokenId: "ANOTHER-TOKEN", kind: "paypal" }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/already has an active saved payment method/) }) });
  });

  it("holds one V1 item at a time through checkout when nothing is saved, and saves the method on consent", async () => {
    await payServicesWithTestCard(false);
    const demo = { paypalClientId: "client-id", testCard: true, sandboxBuyer: null };
    const before = await itemHoldsView(handle.db, session, TEST_KEY, client, demo);
    const first = before.items.find((line) => line.canCheckout)!;
    expect(before).toMatchObject({ savedMethod: null, canHold: false, checkoutOptions: { testCard: true, canSave: true } });
    expect(before.items.every((line) => line.canCheckout)).toBe(true);
    expect((await itemHoldsView(handle.db, session, TEST_KEY, testDesigner, demo)).items.some((line) => line.canCheckout)).toBe(false);

    const checkout = await startItemCheckout(handle.db, paypal, session, TEST_KEY, first.itemId, links, { save: true });
    expect(checkout).toMatchObject({ status: "pending", savePaymentMethod: true, savedMethodId: null });
    // Starting again resumes the same open checkout.
    expect(await startItemCheckout(handle.db, paypal, session, TEST_KEY, first.itemId, links, { save: true })).toMatchObject({ id: checkout.id });
    expect(await approveCheckoutWithTestCard(handle.db, paypal, paypal.confirmWithTestCard, checkout)).toMatchObject({ state: "authorized" });
    expect(await active()).toMatchObject({ kind: "card", label: "Visa •••• 0026", sourceOperationId: checkout.id });

    const after = await itemHoldsView(handle.db, session, TEST_KEY, client, demo);
    expect(after.items.find((line) => line.itemId === first.itemId)).toMatchObject({ state: "held", canCheckout: false });
    expect(after).toMatchObject({ canHold: true, checkoutOptions: null, savedMethod: { kind: "card" } });
    const other = after.items.find((line) => line.state === "to_hold")!;
    await expect(startItemCheckout(handle.db, paypal, session, TEST_KEY, other.itemId, links)).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/Hold the items with it/) });
  });

  it("holds a confirmed version's new amount with the saved method on request, with no PayPal window", async () => {
    const v2 = await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() });
    await expect(startAuthorization(handle.db, paypal, session, v2.id, { itemId: CHAIR, side: "proposed", ...shown(v2) }, links, { via: "saved" }))
      .rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/no saved payment method/) });
    await holdThroughCheckout(v2, "proposed");

    const six = await confirmChange(handle.db, session, TEST_KEY, { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });
    const held = await startAuthorization(handle.db, paypal, session, six.id, { itemId: CHAIR, side: "baseline", ...shown(six) }, links, { via: "saved" });
    expect(held).toMatchObject({ status: "succeeded", approvalUrl: null, savedMethodId: (await active())!.id, amountCents: 27_188 });
    expect(savedOrders()).toHaveLength(1);
  });
});
