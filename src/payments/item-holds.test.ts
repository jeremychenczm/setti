import { randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentOperations, paypalAuthorizations, savedPaymentMethods } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, CONSULTATION, DESK, DESK_CENTS, FURNITURE_CENTS, TEST_KEY, testClient as client, testDesigner as designer, testQuote, TILE } from "../projects/testing";
import { completeAuthorization } from "./authorize";
import { cancelItemHold, checkItemHold, holdApprovedItems } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { lockOpeningVersion } from "./opening";
import { insertOperation } from "./operations";
import { chargeServices, startServicesCheckout } from "./services";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

/** The client of another project. */
const otherClient = { ...client, id: "other-client", name: "Other Client", projectKey: "other-project" };
/** Sofa, chair, desk and tile. */
const FURNITURE = 4;
const allButTile = testQuote.lines.filter((line) => line.itemId !== TILE).map((line) => ({ itemId: line.itemId, decision: "approved" as const }));

describe.skipIf(!testDatabaseUrl)("holding approved items with saved PayPal", () => {
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

  const hold = () => holdApprovedItems(handle.db, paypal, session, TEST_KEY, links);
  const view = (account = client) => itemHoldsView(handle.db, session, TEST_KEY, account);
  const savedHolds = () => handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId));

  /** The client pays the design services, which saves PayPal for the project. */
  async function payServices() {
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
  }

  it("holds every approved item with saved PayPal, each for its own line, with no checkout", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    expect(await view()).toMatchObject({ savedPayPal: false, canHold: false, reason: expect.stringMatching(/Hold each item with PayPal or a card below/) });
    await payServices();
    const before = await view();
    expect(before).toMatchObject({ savedPayPal: true, canHold: true, toHoldCents: FURNITURE_CENTS });

    const held = await hold();
    expect(held).toHaveLength(FURNITURE);
    expect(held.every((operation) => operation.status === "succeeded" && operation.approvalUrl === null && operation.savedMethodId)).toBe(true);
    const [method] = await handle.db.select().from(savedPaymentMethods);
    expect(paypal.calls.filter((call) => "paypalTokenId" in call && call.paypalTokenId === method.paypalTokenId)).toHaveLength(FURNITURE);

    const after = await view();
    expect(after.items.every((line) => line.state === "held" && line.paypalAuthorizationId && line.expiresAt)).toBe(true);
    expect(after).toMatchObject({ toHoldCents: 0, canHold: false, reason: null });
    expect(await hold()).toEqual([]);
  });

  it("leaves other items held while one needs client approval, then finishes that same item and order", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await payServices();
    paypal.then("answer-payer-action");
    const first = await hold();
    const waiting = first.find((operation) => operation.failureCode === "SAVED_PAYPAL_NEEDS_CLIENT")!;
    expect(waiting).toMatchObject({ status: "pending", approvalUrl: expect.stringContaining(waiting.paypalOrderId!) });
    expect(first.filter((operation) => operation.status === "succeeded")).toHaveLength(FURNITURE - 1);
    const before = await view();
    expect(before).toMatchObject({ canHold: false });
    expect(before.items.filter((line) => line.state === "awaiting_client")).toEqual([expect.objectContaining({ operationId: waiting.id, approvalUrl: waiting.approvalUrl, canCheck: true, canCancel: true })]);
    expect((await view(designer)).items.find((line) => line.operationId === waiting.id)).toMatchObject({ approvalUrl: null, canCheck: true, canCancel: false });
    expect((await view(otherClient)).items.find((line) => line.operationId === waiting.id)).toMatchObject({ approvalUrl: null, canCheck: false, canCancel: false });
    expect(await hold()).toEqual([expect.objectContaining({ id: waiting.id, status: "pending", paypalOrderId: waiting.paypalOrderId })]);
    expect(await cancelItemHold(handle.db, paypal, session, TEST_KEY, waiting.id)).toMatchObject({ id: waiting.id, status: "pending", failureCode: "CHECKOUT_CANCEL_REQUESTED" });
    paypal.approve(waiting.paypalOrderId!);
    expect(await checkItemHold(handle.db, paypal, session, TEST_KEY, waiting.id)).toMatchObject({ status: "succeeded", itemId: waiting.itemId, paypalOrderId: waiting.paypalOrderId });
    expect((await view()).items.every((line) => line.state === "held")).toBe(true);
    expect(await hold()).toEqual([]);
    expect(paypal.calls.filter((call) => "paypalTokenId" in call)).toHaveLength(FURNITURE);
    expect(await handle.db.select().from(paypalAuthorizations).where(isNotNull(paypalAuthorizations.itemId))).toHaveLength(FURNITURE);
  });

  it("finishes a hold whose answer was lost before holding anything else", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await payServices();
    paypal.then("lose-response");
    const first = await hold();
    const lost = first.find((operation) => operation.status === "unknown")!;
    expect(lost).toBeTruthy();
    expect((await view()).items.find((line) => line.state === "unknown")).toMatchObject({ operationId: lost.id, canCheck: true, approvalUrl: null });
    expect(await hold()).toEqual([expect.objectContaining({ id: lost.id, status: "succeeded" })]);
    expect(await hold()).toEqual([]);
    expect(await handle.db.select().from(paypalAuthorizations).where(isNotNull(paypalAuthorizations.itemId))).toHaveLength(FURNITURE);
  });

  it("refuses to reconcile another session's item hold", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await payServices();
    paypal.then("answer-payer-action");
    const waiting = (await hold()).find((operation) => operation.approvalUrl)!;
    await expect(checkItemHold(handle.db, paypal, randomUUID(), TEST_KEY, waiting.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancelItemHold(handle.db, paypal, randomUUID(), TEST_KEY, waiting.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(paypal.calls.filter((call) => "paypalTokenId" in call)).toHaveLength(FURNITURE);
  });

  it("holds a line the client signs later, with the same saved PayPal", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY, allButTile);
    await payServices();
    expect(await hold()).toHaveLength(FURNITURE - 1);
    await signOpeningForTest(handle.db, session, TEST_KEY, [{ itemId: TILE, decision: "approved" }]);
    const later = await hold();
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ status: "succeeded" });
    expect(await savedHolds()).toHaveLength(FURNITURE);
  });

  it("keeps an older legacy-review warning visible after a later hold succeeded on that item", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY, allButTile);
    await payServices();
    const [succeeded] = await hold();
    const fundedLine = (await view()).items.find((line) => line.paypalAuthorizationId === succeeded.paypalResourceId)!;
    expect(fundedLine.state).toBe("held");
    await signOpeningForTest(handle.db, session, TEST_KEY, [{ itemId: TILE, decision: "approved" }]);
    expect(await view()).toMatchObject({ canHold: true, toHoldCents: expect.any(Number) });

    // Model the exact post-migration state without weakening a database trigger:
    // an older unresolved provider order beside the already completed later attempt.
    const legacyId = randomUUID();
    const warning = "This item has multiple authorization attempts. The original PayPal orders need manual review; no automatic authorization or replacement is allowed.";
    await handle.db.insert(paymentOperations).values({ ...succeeded, id: legacyId, businessKey: `legacy-review:${legacyId}`, requestId: `setti-op-${legacyId}`,
      status: "unknown", failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED", failureMessage: warning,
      paypalOrderId: "LEGACY-ORDER", paypalResourceId: null, approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=LEGACY-ORDER",
      createdAt: new Date(succeeded.createdAt.getTime() - 1_000), updatedAt: new Date(), attempts: 0 });

    const reads = paypal.reads.length, writes = paypal.calls.length;
    for (const account of [client, designer]) {
      const blocked = await view(account);
      expect(blocked).toMatchObject({ canHold: false, reason: warning });
      expect(blocked.toHoldCents).toBeGreaterThan(0);
      expect(blocked.items.find((line) => line.itemId === fundedLine.itemId)).toMatchObject({ state: "unknown", operationId: legacyId,
        heldCents: succeeded.amountCents, failureMessage: warning, approvalUrl: null, canCancel: false });
    }
    expect(await hold()).toEqual([expect.objectContaining({ id: legacyId, failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED" })]);
    expect(await checkItemHold(handle.db, paypal, session, TEST_KEY, legacyId)).toMatchObject({ id: legacyId, status: "unknown", failureCode: "LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED" });
    expect(paypal.reads).toHaveLength(reads);
    expect(paypal.calls).toHaveLength(writes);
  });

  it("needs saved PayPal and an account of the project", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await expect(hold()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/Paying with PayPal or a card can save one/) });
    await payServices();
    expect(await view(designer)).toMatchObject({ canHold: true });
    expect(await view(otherClient)).toMatchObject({ canHold: false, reason: expect.stringMatching(/Only the project's client or designer/) });
  });

  it("refuses a saved-PayPal hold above the item's line or for a design service", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await payServices();
    const [method] = await handle.db.select().from(savedPaymentMethods);
    const version = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, TEST_KEY, null));
    const itemOf = (quoteItemId: string) => version.approved.find((entry) => entry.line.itemId === quoteItemId)!;
    const desk = itemOf(DESK);
    const write = (itemId: string, amountCents: number) => insertOperation(handle.db, { businessKey: `test:${randomUUID()}`, projectId: version.projectId, kind: "authorize", amountCents, binding: version.bind(itemId), savedMethodId: method.id });
    await expect(write(desk.itemId, DESK_CENTS + 1)).rejects.toMatchObject({ message: expect.stringMatching(/cannot exceed the item's line/) });
    await expect(write(itemOf(CONSULTATION).itemId, 10_000)).rejects.toMatchObject({ message: expect.stringMatching(/holds only this project's furniture/) });
    expect(await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, desk.itemId))).toHaveLength(0);
  });
});
