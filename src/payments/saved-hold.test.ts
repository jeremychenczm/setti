import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { createChatStore } from "../chat/store";
import { paymentOperations, paypalAuthorizations, paypalCalls, savedPaymentMethods } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { cancelPayment, checkPayment, returnFromPayPal } from "./actions";
import { completeAuthorization, createCheckout } from "./authorize";
import { businessItem, lockConfirmedVersion } from "./binding";
import { insertOperation, type OperationRequest } from "./operations";
import { executeSavedHold } from "./saved-hold";
import { bergmund, confirmChange, confirmChanges, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

const details = { description: "Willow Residence · BERGMUND Chair (Setti sandbox demo)", savePayPalDescription: "Setti · Willow Residence: holds for the items you approve (sandbox demo)" };

describe.skipIf(!testDatabaseUrl)("holds placed with saved PayPal", () => {
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
  });
  afterAll(() => handle?.pool.end());

  /** Writes an authorize operation for one chair line of a confirmed version, as a payment entry would. */
  const writeHold = (order: FrozenChangeOrder, side: "baseline" | "proposed", amountCents: number, extra: Partial<OperationRequest> = {}) =>
    handle.db.transaction(async (tx) => {
      const version = await lockConfirmedVersion(tx, session, order.id, shown(order));
      const itemId = businessItem(version, { itemId: CHAIR, side });
      return insertOperation(tx, { businessKey: `test:${randomUUID()}`, projectId: version.projectId, kind: "authorize", amountCents, binding: version.bind(itemId), ...extra });
    });

  /** The client approves V2's $543.75 chair hold on (fake) PayPal and agrees to save PayPal. */
  async function checkoutSavingPayPal(...behaviours: Parameters<FakePayPal["then"]>) {
    const checkout = await createCheckout(handle.db, paypal, await writeHold(v2, "proposed", 54_375, { savePaymentMethod: true }), links(randomUUID()), details);
    paypal.approve(checkout.paypalOrderId!);
    paypal.then(...behaviours);
    return { checkout, result: await completeAuthorization(handle.db, paypal, checkout.id) };
  }

  const savedMethods = () => handle.db.select().from(savedPaymentMethods);
  const v3 = () => confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } });

  it("saves PayPal with the first hold, then holds V3's extra $271.88 with no buyer on PayPal", async () => {
    const { checkout, result } = await checkoutSavingPayPal();
    expect(paypal.calls[0]).toMatchObject({ amountCents: 54_375, savePayPal: { description: details.savePayPalDescription } });
    expect(result.state).toBe("authorized");
    const [method] = await savedMethods();
    expect(method).toMatchObject({ sourceOperationId: checkout.id, projectId: checkout.projectId, paypalTokenId: paypal.savedTokens[0] });

    const third = await v3();
    const pending = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    const held = await executeSavedHold(handle.db, paypal, pending.id, details);
    expect(held).toMatchObject({ status: "succeeded", approvalUrl: null, savedMethodId: method.id });
    expect(paypal.calls.at(-1)).toMatchObject({ paypalTokenId: method.paypalTokenId, amountCents: 27_188, customId: pending.id, requestId: pending.requestId });
    const holds = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, pending.id));
    expect(holds).toEqual([expect.objectContaining({ amountCents: 27_188, status: "created", changeOrderId: third.id, paypalAuthorizationId: held.paypalResourceId })]);
    const messages = (await createChatStore(handle.db).getCase(session, "willow")).messages.map((message) => message.text);
    expect(messages).toContainEqual(expect.stringMatching(/543\.75 USD is held.*The client saved PayPal for this project's later holds\.$/));
    expect(messages.at(-1)).toMatch(/authorization recorded with the client's saved PayPal for V3 .*271\.88 USD is held/);
  });

  it("keeps the saved token out of operations, call evidence, the payments page and the chat", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    await executeSavedHold(handle.db, paypal, (await writeHold(third, "baseline", 27_188, { savedMethodId: method.id })).id, details);

    const calls = await handle.db.select().from(paypalCalls);
    expect(calls.find((call) => call.step === "authorize_order")?.details).toMatchObject({ savedPayPal: "VAULTED" });
    const visible = JSON.stringify([
      await handle.db.select().from(paymentOperations), calls, await handle.db.select().from(paypalAuthorizations),
      await paymentsWorkspace(handle.db, session, v2.id), await paymentsWorkspace(handle.db, session, third.id),
      await createChatStore(handle.db).getCase(session, "willow"),
    ]);
    expect(visible).not.toContain(method.paypalTokenId);
  });

  it("finds the token on the order when PayPal's authorize answer was minimal", async () => {
    const { result } = await checkoutSavingPayPal("answer-minimal");
    expect(result.state).toBe("authorized");
    expect(await savedMethods()).toEqual([expect.objectContaining({ paypalTokenId: paypal.savedTokens[0] })]);
  });

  it("records the hold but saves nothing when PayPal did not save the buyer's PayPal", async () => {
    const { result } = await checkoutSavingPayPal("answer-unsaved");
    expect(result.state).toBe("authorized");
    expect(await savedMethods()).toHaveLength(0);
    expect((await createChatStore(handle.db).getCase(session, "willow")).messages.at(-1)?.text).not.toMatch(/saved PayPal/);
  });

  it("saves nothing from a checkout that did not ask, even if PayPal returned a token", async () => {
    const checkout = await createCheckout(handle.db, paypal, await writeHold(v2, "proposed", 54_375), links(randomUUID()), details);
    expect(paypal.calls[0]).not.toHaveProperty("savePayPal");
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    expect(await savedMethods()).toHaveLength(0);
  });

  it("recovers a lost answer with the same request id and never holds twice", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const pending = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    paypal.then("lose-response");
    expect(await executeSavedHold(handle.db, paypal, pending.id, details)).toMatchObject({ status: "unknown" });
    const checked = await checkPayment(handle.db, paypal, session, third.id, pending.id, links);
    expect(checked).toMatchObject({ status: "succeeded", attempts: 2 });
    const sent = paypal.calls.filter((call) => "paypalTokenId" in call);
    expect(sent.map((call) => call.requestId)).toEqual([pending.requestId, pending.requestId]);
    expect(await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, pending.id))).toHaveLength(1);
  });

  it("reads a minimal answer back from the order before recording the hold", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const pending = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    paypal.then("answer-minimal");
    const held = await executeSavedHold(handle.db, paypal, pending.id, details);
    expect(held.status).toBe("succeeded");
    const steps = (await handle.db.select().from(paypalCalls).where(eq(paypalCalls.operationId, pending.id))).map((call) => call.step);
    expect(steps).toEqual(["create_order", "get_order"]);
  });

  it("leaves ambiguous legacy saved-method orders for manual review without provider reads or writes", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const pending = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    await handle.db.update(paymentOperations).set({ status: "unknown", failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED", failureMessage: "Several legacy attempts need manual reconciliation." }).where(eq(paymentOperations.id, pending.id));
    const reads = paypal.reads.length, writes = paypal.calls.length;
    expect(await executeSavedHold(handle.db, paypal, pending.id, details)).toMatchObject({ status: "unknown", failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED" });
    expect(await checkPayment(handle.db, paypal, session, third.id, pending.id, links)).toMatchObject({ status: "unknown", failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED" });
    expect(paypal.reads).toHaveLength(reads);
    expect(paypal.calls).toHaveLength(writes);
  });

  it("continues the same saved-method order through client approval, callback and repeated checks", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const needsClient = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    paypal.then("answer-payer-action");
    const waiting = await executeSavedHold(handle.db, paypal, needsClient.id, details, links(needsClient.id));
    expect(waiting).toMatchObject({ status: "pending", failureCode: "SAVED_PAYPAL_NEEDS_CLIENT", approvalUrl: expect.stringContaining(waiting.paypalOrderId!) });
    const client = DEMO_ACCOUNTS.find((account) => account.projectKey === "willow")!;
    const clientView = await paymentsWorkspace(handle.db, session, third.id, undefined, client);
    expect(clientView?.operations.find((operation) => operation.id === needsClient.id)).toMatchObject({ approvalUrl: waiting.approvalUrl, canContinue: true, canCheck: true, canCancel: true });
    const designerView = await paymentsWorkspace(handle.db, session, third.id, undefined, DEMO_ACCOUNTS[0]);
    expect(designerView?.operations.find((operation) => operation.id === needsClient.id)).toMatchObject({ approvalUrl: null, canContinue: false, canCheck: true, canCancel: false });
    expect(await returnFromPayPal(handle.db, paypal, waiting.id, "another-order", "return")).toBeNull();
    expect(await checkPayment(handle.db, paypal, session, third.id, waiting.id, links)).toMatchObject({ status: "pending", paypalOrderId: waiting.paypalOrderId });
    paypal.approve(waiting.paypalOrderId!);
    expect(await returnFromPayPal(handle.db, paypal, waiting.id, waiting.paypalOrderId, "return")).toMatchObject({ state: "authorized" });
    expect(await checkPayment(handle.db, paypal, session, third.id, waiting.id, links)).toMatchObject({ status: "succeeded", id: waiting.id });
    expect(paypal.calls.filter((call) => "paypalTokenId" in call)).toHaveLength(1);
    expect(paypal.calls.filter((call) => "orderId" in call && call.orderId === waiting.paypalOrderId)).toHaveLength(1);
    expect(await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, waiting.id))).toHaveLength(1);
  });

  it("keeps a cancelled fallback open, records a late approval and recovers a lost authorize response", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const operation = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    paypal.then("answer-payer-action");
    const waiting = await executeSavedHold(handle.db, paypal, operation.id, details);
    expect(await cancelPayment(handle.db, paypal, session, third.id, operation.id)).toMatchObject({ id: operation.id, status: "pending", failureCode: "CHECKOUT_CANCEL_REQUESTED" });
    paypal.readsUnavailable = true;
    expect(await checkPayment(handle.db, paypal, session, third.id, operation.id, links)).toMatchObject({ status: "pending", paypalOrderId: waiting.paypalOrderId });
    paypal.readsUnavailable = false;
    paypal.approve(waiting.paypalOrderId!);
    paypal.then("lose-response");
    expect(await returnFromPayPal(handle.db, paypal, operation.id, waiting.paypalOrderId, "return")).toMatchObject({ state: "unknown" });
    expect(await checkPayment(handle.db, paypal, session, third.id, operation.id, links)).toMatchObject({ status: "succeeded", id: operation.id });
    expect(await cancelPayment(handle.db, paypal, session, third.id, operation.id)).toMatchObject({ status: "succeeded" });
    expect(paypal.calls.filter((call) => "paypalTokenId" in call)).toHaveLength(1);
    expect(await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, operation.id))).toHaveLength(1);
  });

  it.each([undefined, "https://attacker.example/checkout?token=x", "https://www.sandbox.paypal.com/checkoutnow?token=another-order"])("keeps an unverified payer-action link unknown rather than replacing the hold: %s", async (approvalUrl) => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const operation = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    const original = paypal.createSavedPayPalOrder.bind(paypal);
    paypal.createSavedPayPalOrder = async (command) => {
      const result = await original(command);
      return result.kind === "ok" ? { ...result, value: { ...result.value, approvalUrl } } : result;
    };
    paypal.then("answer-payer-action");
    expect(await executeSavedHold(handle.db, paypal, operation.id, details)).toMatchObject({ status: "unknown", failureCode: "SAVED_PAYPAL_APPROVAL_UNAVAILABLE", approvalUrl: null });
    // Checking recovers the real provider order/link; it does not retry the saved token.
    expect(await checkPayment(handle.db, paypal, session, third.id, operation.id, links)).toMatchObject({ status: "pending", failureCode: "SAVED_PAYPAL_NEEDS_CLIENT" });
    expect(paypal.calls.filter((call) => "paypalTokenId" in call)).toHaveLength(1);
  });

  it("holds nothing when PayPal reports another amount", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const otherAmount = await writeHold(third, "baseline", 27_188, { savedMethodId: method.id });
    paypal.then("answer-other-amount");
    expect(await executeSavedHold(handle.db, paypal, otherAmount.id, details)).toMatchObject({ status: "unknown", failureCode: "RECEIPT_MISMATCH" });
    expect(await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.changeOrderId, third.id))).toHaveLength(0);
  });

  it("has no checkout to cancel or return from", async () => {
    await checkoutSavingPayPal();
    const [method] = await savedMethods();
    const third = await v3();
    const held = await executeSavedHold(handle.db, paypal, (await writeHold(third, "baseline", 27_188, { savedMethodId: method.id })).id, details);
    await expect(cancelPayment(handle.db, paypal, session, third.id, held.id)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    expect(await returnFromPayPal(handle.db, paypal, held.id, held.paypalOrderId, "return")).toBeNull();
  });

  describe("database rules", () => {
    const refused = /saved PayPal|PayPal is saved only|violates check constraint|cannot be deleted|cannot change|current client-confirmed version/;

    it("saves PayPal only from this project's succeeded checkout that asked to save it", async () => {
      const save = (projectId: string, sourceOperationId: string, paypalTokenId: string) => handle.db.insert(savedPaymentMethods).values({ projectId, sourceOperationId, paypalTokenId });
      const { checkout } = await checkoutSavingPayPal("answer-unsaved");
      const maple = await confirmChanges(handle.db, session, "maple", [{ action: "replace", itemId: "chair", after: bergmund() }]);
      const [mapleProject] = await handle.db.execute<{ project_id: string }>(sql`SELECT project_id FROM pricing_cases WHERE case_id = (SELECT case_id FROM change_orders WHERE id = ${maple.id})`).then((result) => result.rows);
      await expect(save(mapleProject.project_id, checkout.id, "TOKEN-1")).rejects.toThrow();

      const plain = await createCheckout(handle.db, paypal, await writeHold(v2, "proposed", 54_375), links(randomUUID()), details);
      paypal.approve(plain.paypalOrderId!);
      expect((await completeAuthorization(handle.db, paypal, plain.id)).state).toBe("authorized");
      await expect(save(plain.projectId, plain.id, "TOKEN-2")).rejects.toThrow();

      const open = await writeHold(v2, "proposed", 54_375, { savePaymentMethod: true });
      await expect(save(open.projectId, open.id, "TOKEN-3")).rejects.toThrow();
      expect(await savedMethods()).toHaveLength(0);

      await save(checkout.projectId, checkout.id, "TOKEN-4");
      expect(await savedMethods()).toHaveLength(1);
    });

    it("never changes or deletes saved PayPal, and never lends it to another project", async () => {
      await checkoutSavingPayPal();
      const [method] = await savedMethods();
      await expect(handle.db.update(savedPaymentMethods).set({ paypalTokenId: "OTHER" }).where(eq(savedPaymentMethods.id, method.id))).rejects.toThrow();
      await expect(handle.db.delete(savedPaymentMethods).where(eq(savedPaymentMethods.id, method.id))).rejects.toThrow();

      const maple = await confirmChanges(handle.db, session, "maple", [{ action: "replace", itemId: "chair", after: bergmund() }]);
      const borrowing = handle.db.transaction(async (tx) => {
        const version = await lockConfirmedVersion(tx, session, maple.id, shown(maple));
        const itemId = businessItem(version, { itemId: "chair", side: "proposed" });
        return insertOperation(tx, { businessKey: "test:borrowed", projectId: version.projectId, kind: "authorize", amountCents: 54_375, binding: version.bind(itemId), savedMethodId: method.id });
      });
      await expect(borrowing).rejects.toMatchObject({ message: expect.stringMatching(/saved PayPal belongs to another project/) });
    });

    it("holds only lines of the current client-confirmed version", async () => {
      await checkoutSavingPayPal();
      const [method] = await savedMethods();
      const [chair] = await handle.db.select({ itemId: paymentOperations.itemId }).from(paymentOperations);
      const unconfirmed = await confirmChange(handle.db, session, "willow", { action: "quantity", itemId: CHAIR, quantity: 6, after: { taxCents: 6_563 } }, false);
      const binding = { changeOrderId: unconfirmed.id, revisionId: unconfirmed.revisionId, contentHash: unconfirmed.contentHash, revisionContentHash: unconfirmed.revisionContentHash, itemId: chair.itemId! };
      await expect(insertOperation(handle.db, { businessKey: "test:unconfirmed", projectId: method.projectId, kind: "authorize", amountCents: 27_188, binding, savedMethodId: method.id }))
        .rejects.toMatchObject({ message: expect.stringMatching(refused) });
    });

    it("keeps a saved-PayPal hold's source, provider order and first approval link fixed", async () => {
      await checkoutSavingPayPal();
      const [method] = await savedMethods();
      const pending = await writeHold(await v3(), "baseline", 27_188, { savedMethodId: method.id });
      paypal.then("answer-payer-action");
      const waiting = await executeSavedHold(handle.db, paypal, pending.id, details);
      expect(waiting.approvalUrl).toBeTruthy();
      await expect(handle.db.update(paymentOperations).set({ approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=X" }).where(eq(paymentOperations.id, pending.id))).rejects.toThrow();
      await expect(handle.db.update(paymentOperations).set({ paypalOrderId: "another-order" }).where(eq(paymentOperations.id, pending.id))).rejects.toThrow();
      await expect(handle.db.update(paymentOperations).set({ savedMethodId: null }).where(eq(paymentOperations.id, pending.id))).rejects.toThrow();
      await expect(handle.db.update(paymentOperations).set({ savePaymentMethod: true }).where(eq(paymentOperations.id, pending.id))).rejects.toThrow();
    });
  });
});
