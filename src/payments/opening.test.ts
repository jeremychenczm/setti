import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import { paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { pricingCases } from "../pricing/schema";
import { addTestProject, CHAIR, DESK, SOFA, TEST_KEY, testQuote, TILE } from "../projects/testing";
import { completeAuthorization, createCheckout } from "./authorize";
import { lockOpeningVersion, openingPlan } from "./opening";
import { insertOperation, type OperationRequest } from "./operations";
import { bergmund, confirmChange } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const details = { description: "Fernhill Apartment · Desk · V1 (Setti sandbox demo)", savePayPalDescription: "Setti · Fernhill Apartment: holds for the items you approve (sandbox demo)" };

describe.skipIf(!testDatabaseUrl)("payments for a V1 signed line by line", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
    // Every line approved except the sofa (declined) and the tile (left undecided).
    const decisions = testQuote.lines.filter((line) => line.itemId !== TILE).map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const });
    await signOpeningForTest(handle.db, session, TEST_KEY, decisions);
  });
  afterAll(() => handle?.pool.end());

  const lock = (sessionId = session) => handle.db.transaction(async (tx) => {
    const version = await lockOpeningVersion(tx, sessionId, TEST_KEY, null);
    return { version, ...(await openingPlan(tx, version)) };
  });

  /** The business item behind any V1 line, approved or not. */
  async function businessItem(quoteItemId: string): Promise<string> {
    const [bridge] = await handle.db.select().from(pricingCases);
    return Object.entries(bridge.itemMapping).find(([key]) => key.startsWith(`${quoteItemId}:`))![1];
  }

  /** Writes the hold the V1 plan asks for on one approved furniture line. */
  const writeHold = (quoteItemId: string, extra: Partial<OperationRequest> = {}) => handle.db.transaction(async (tx) => {
    const version = await lockOpeningVersion(tx, session, TEST_KEY, null);
    const { plan } = await openingPlan(tx, version);
    const action = plan.actions.find((entry) => entry.itemId === quoteItemId && entry.kind === "new_authorization")!;
    const { itemId } = version.approved.find((entry) => entry.line.itemId === quoteItemId)!;
    return insertOperation(tx, { businessKey: `test:${randomUUID()}`, projectId: version.projectId, kind: "authorize", amountCents: action.amountCents, binding: version.bind(itemId), ...extra });
  });

  async function holdDeskSavingPayPal() {
    const checkout = await createCheckout(handle.db, paypal, await writeHold(DESK, { savePaymentMethod: true }), links(randomUUID()), details);
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    return checkout;
  }

  const lastMessage = async () => (await createChatStore(handle.db).getCase(session, TEST_KEY)).messages.at(-1)?.text;

  it("plans to fund exactly the approved V1 lines: holds for furniture, charges for design services", async () => {
    const { plan } = await lock();
    expect(plan).toMatchObject({ status: "not_authorized", version: 1, basedOnVersion: 0, blockers: [] });
    expect(plan.lines.map((line) => line.itemId).sort()).toEqual([CHAIR, DESK, "fernhill-consultation", "fernhill-planning"].sort());
    const services = plan.actions.filter((action) => action.kind === "capture");
    expect(services).toHaveLength(2);
    expect(services.every((action) => action.timing === "on_payment_execution")).toBe(true);
    // Consultation $300.00 + planning $500.00 charged; chair $345.60 + desk $270.00 held.
    expect(plan.money.chargeCents).toBe(80_000);
    expect(plan.actions.filter((action) => action.kind === "new_authorization").map((action) => action.itemId).sort()).toEqual([CHAIR, DESK].sort());
    expect(plan.money.newAuthorizationCents).toBe(61_560);
    expect(plan.quoteDeltaCents).toBe(141_560);
  });

  it("holds an approved V1 line through checkout and records it against V1", async () => {
    const checkout = await holdDeskSavingPayPal();
    const { version, plan } = await lock();
    expect(checkout).toMatchObject({ changeOrderId: null, revisionId: version.revisionId, contentHash: version.contentHash });
    const [hold] = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, checkout.id));
    expect(hold).toMatchObject({ changeOrderId: null, amountCents: checkout.amountCents, status: "created" });
    expect(await lastMessage()).toMatch(/authorization recorded for V1 · .*is held.*The client saved b•••@personal\.example\.com for this project's later holds\.$/);

    const desk = plan.lines.find((line) => line.itemId === DESK)!;
    expect(desk.heldCents).toBe(checkout.amountCents);
    expect(plan.actions.filter((action) => action.itemId === DESK).map((action) => [action.kind, action.timing])).toEqual([["capture", "after_vendor_confirmation"]]);
  });

  describe("database rules", () => {
    async function bound(quoteItemId: string, extra: Partial<OperationRequest> = {}) {
      const { version } = await lock();
      return insertOperation(handle.db, { businessKey: `test:${randomUUID()}`, projectId: version.projectId, kind: "authorize", amountCents: 10_000, binding: version.bind(await businessItem(quoteItemId)), ...extra });
    }

    it("refuses lines the client declined or left undecided", async () => {
      await expect(bound(SOFA)).rejects.toMatchObject({ message: expect.stringMatching(/has not approved this line of quote V1/) });
      await expect(bound(TILE)).rejects.toMatchObject({ message: expect.stringMatching(/has not approved this line of quote V1/) });
    });

    it("refuses a V1 binding with hashes the client did not sign", async () => {
      const { version } = await lock();
      const binding = { ...version.bind(await businessItem(DESK)), contentHash: "0".repeat(64) };
      await expect(insertOperation(handle.db, { businessKey: "test:other-hash", projectId: version.projectId, kind: "authorize", amountCents: 10_000, binding }))
        .rejects.toMatchObject({ message: expect.stringMatching(/does not match the signed quote V1/) });
    });

    it("binds only holds to V1 for now", async () => {
      await holdDeskSavingPayPal();
      const [hold] = await handle.db.select().from(paypalAuthorizations);
      await expect(bound(DESK, { kind: "capture", authorizationId: hold.id, finalCapture: true }))
        .rejects.toMatchObject({ message: expect.stringMatching(/a capture cannot be bound to quote V1 yet/) });
    });

    it("stops V1 payments once a newer version replaces V1", async () => {
      const { version } = await lock();
      const desk = await businessItem(DESK);
      await confirmChange(handle.db, session, TEST_KEY, { action: "replace", itemId: CHAIR, after: bergmund() }, false);
      await expect(lock()).rejects.toMatchObject({ code: "STALE_VERSION" });
      await expect(insertOperation(handle.db, { businessKey: "test:after-v2", projectId: version.projectId, kind: "authorize", amountCents: 10_000, binding: version.bind(desk) }))
        .rejects.toMatchObject({ message: expect.stringMatching(/quote V1 is superseded/) });
    });
  });

  it("starts only for the owning session, after the client approved a line of a V1 sent from the chat", async () => {
    await expect(lock("not-a-session")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lock(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handle.db.transaction((tx) => lockOpeningVersion(tx, session, "maple", null))).rejects.toMatchObject({ code: "NOT_FOUND" });

    const declinedOnly = randomUUID();
    await addTestProject(handle.db, declinedOnly);
    await signOpeningForTest(handle.db, declinedOnly, TEST_KEY, [{ itemId: SOFA, decision: "declined", note: "Too big for the room." }]);
    await expect(lock(declinedOnly)).rejects.toMatchObject({ code: "NOT_CONFIRMED" });
  });
});
