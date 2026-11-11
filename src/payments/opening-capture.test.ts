import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { paypalAuthorizations, paypalCaptures, supplierEvents } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { pricingCases } from "../pricing/schema";
import { addTestProject, DESK, DESK_CENTS, SOFA, TEST_KEY, testClient as client, testDesigner as designer, testLine, testQuote } from "../projects/testing";
import { startOpeningCapture } from "./actions";
import { completeAuthorization } from "./authorize";
import { holdApprovedItems } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { lockOpeningVersion } from "./opening";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { bergmund, confirmChange } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, links } from "./testing/flows";

/** 1 × $250.00 + $20.00 tax = $270.00. */
const desk = testLine(DESK);

describe.skipIf(!testDatabaseUrl)("supplier confirmation and capture on a signed V1", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let contentHash: string;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
    // Every line approved except the sofa, then the services paid and the items held.
    await signOpeningForTest(handle.db, session, TEST_KEY, testQuote.lines.map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
    await holdApprovedItems(handle.db, paypal, session, TEST_KEY);
    contentHash = (await handle.db.transaction((tx) => lockOpeningVersion(tx, session, TEST_KEY, null))).contentHash;
  });
  afterAll(() => handle?.pool.end());

  const confirm = (terms: Partial<{ quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; reference: string }> = {}, itemId = DESK) => recordOpeningSupplierOrder(handle.db, session, TEST_KEY, {
    itemId, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
    inStock: true, leadTimeDays: 10, reference: "BD-SO-1001", note: "", ...terms,
  });
  const capture = () => startOpeningCapture(handle.db, paypal, session, TEST_KEY, { itemId: DESK, contentHash });
  const deskLine = async (account = designer) => (await itemHoldsView(handle.db, session, TEST_KEY, account)).items.find((line) => line.itemId === DESK)!;

  it("captures a held V1 item once the supplier confirms the approved terms", async () => {
    expect(await deskLine()).toMatchObject({ state: "held", terms: { quantity: desk.quantity, unitPriceCents: desk.unitPriceCents }, supplier: null });
    await expect(capture()).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringMatching(/Record the supplier's order confirmation/) });

    const event = await confirm();
    expect(event).toMatchObject({ changeOrderId: null, kind: "order_confirmed", totalCents: DESK_CENTS });
    expect(await deskLine()).toMatchObject({ state: "confirmed", supplier: { reference: "BD-SO-1001", totalCents: DESK_CENTS } });

    const [captured] = await capture();
    expect(captured).toMatchObject({ status: "succeeded", kind: "capture", amountCents: DESK_CENTS, finalCapture: true, supplierEventId: event.id, changeOrderId: null });
    const [hold] = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, captured.authorizationId!));
    expect(hold.status).toBe("captured");
    expect(await handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.operationId, captured.id))).toHaveLength(1);
    expect(await deskLine()).toMatchObject({ state: "captured", capturedCents: DESK_CENTS });
    const messages = (await createChatStore(handle.db).getCase(session, TEST_KEY)).messages.map((message) => message.text);
    expect(messages).toContainEqual(expect.stringMatching(/supplier confirmation recorded by the designer for V1 · Writing desk/));
    expect(messages.at(-1)).toMatch(/capture completed for V1 · Writing desk/);
    expect(await capture()).toEqual([expect.objectContaining({ id: captured.id })]);
  });

  it("captures nothing when the supplier's terms differ from the approved line", async () => {
    await expect(confirm({ unitPriceCents: desk.unitPriceCents + 1_000 })).rejects.toMatchObject({ code: "SUPPLIER_TERMS_CHANGED", details: [expect.stringMatching(/unit price/)] });
    expect(await handle.db.select().from(supplierEvents)).toHaveLength(0);
    const first = await confirm();
    expect((await confirm()).id).toBe(first.id);
    await expect(confirm({ reference: "OTHER" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("lets only the designer confirm suppliers here, and only on V1", async () => {
    expect((await itemHoldsView(handle.db, session, TEST_KEY, designer)).canConfirmSupplier).toBe(true);
    expect((await itemHoldsView(handle.db, session, TEST_KEY, client)).canConfirmSupplier).toBe(false);
    await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() });
    await expect(confirm()).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await itemHoldsView(handle.db, session, TEST_KEY, designer)).canConfirmSupplier).toBe(false);
  });

  describe("database rules", () => {
    async function scope() {
      const version = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, TEST_KEY, null));
      const [bridge] = await handle.db.select().from(pricingCases);
      const sofaItem = Object.entries(bridge.itemMapping).find(([key]) => key.startsWith(`${SOFA}:`))![1];
      return { version, sofaItem, deskItem: version.approved.find((entry) => entry.line.itemId === DESK)!.itemId };
    }
    const event = (values: Partial<typeof supplierEvents.$inferInsert> & { projectId: string; itemId: string }) => handle.db.insert(supplierEvents).values({
      revisionId: null, changeOrderId: null, kind: "order_confirmed", quantity: 1, unitPriceCents: 100, taxCents: 0, freightCents: 0, inStock: true, totalCents: 100, reference: "X", sessionId: session, ...values,
    });

    it("records V1 supplier events only for approved lines, by the owning session, as order confirmations", async () => {
      const { version, sofaItem, deskItem } = await scope();
      await expect(event({ projectId: version.projectId, itemId: sofaItem, revisionId: version.revisionId })).rejects.toThrow();
      await expect(event({ projectId: version.projectId, itemId: deskItem, revisionId: version.revisionId, sessionId: randomUUID() })).rejects.toThrow();
      await expect(event({ projectId: version.projectId, itemId: deskItem, revisionId: version.revisionId, kind: "credit_confirmed", quantity: null, unitPriceCents: null, taxCents: null, freightCents: null, inStock: null })).rejects.toThrow();
      await expect(event({ projectId: version.projectId, itemId: deskItem })).rejects.toThrow();
      await event({ projectId: version.projectId, itemId: deskItem, revisionId: version.revisionId });
      expect(await handle.db.select().from(supplierEvents)).toHaveLength(1);
    });
  });
});
