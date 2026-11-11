import { randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApprovalStore } from "../approval/store";
import { createChatStore } from "../chat/store";
import { paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { clientSignatureName } from "../opening/types";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "../payments/authorize";
import { holdApprovedItems } from "../payments/item-holds";
import { chargeServices, startServicesCheckout } from "../payments/services";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { paymentsWorkspace } from "../payments/workspace";
import { addTestProject, DESK, SOFA, TEST_KEY, testLine, testQuote, TILE } from "../projects/testing";
import { createPricingInput, type SupplierConfirmation } from "./calculation";
import { startLineChange } from "./line-change";
import { createPricingStore } from "./store";
import type { ChangeSource, FrozenChangeOrder } from "./types";

// The desk: 1 × $250.00 + $20.00 tax, no delivery, from Brightdesk Office. Repriced: $275.00 + 8% tax ($22.00).
const desk = testLine(DESK);
const NEW_PRICE = 27_500, NEW_TAX = 2_200;
const NOTICE: ChangeSource = { kind: "vendor", vendor: "Brightdesk Office", notice: "From November 1 the writing desk is $275.00 (was $250.00) because of a lumber surcharge." };

describe.skipIf(!testDatabaseUrl)("the designer changes an approved line", () => {
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

  const change = (itemId = DESK) => startLineChange(handle.db, session, TEST_KEY, { itemId });
  /** The desk's supplier confirms it at a higher price. */
  const confirmation = (overrides: Partial<SupplierConfirmation> = {}): SupplierConfirmation => ({ reference: "QO-4471", quantity: 1, unitPriceCents: NEW_PRICE, taxCents: NEW_TAX, freightCents: 0, leadTimeDays: 21, ...overrides });
  const fromSupplier = (supplier: SupplierConfirmation, itemId = DESK) => startLineChange(handle.db, session, TEST_KEY, { itemId, supplier });

  /** The designer reprices the desk from the supplier's notice and issues the version; the client confirms it unless told not to. */
  async function reprice(source: ChangeSource = NOTICE, confirm = true): Promise<FrozenChangeOrder> {
    const { draft } = await change();
    const pricing = createPricingStore(handle.db);
    const workspace = await pricing.getWorkspace(session, TEST_KEY);
    const quote = (await createChatStore(handle.db).getCase(session, TEST_KEY)).quote!;
    const input = createPricingInput(quote, draft);
    input.source = source;
    input.terms = "The desk price follows the supplier's notice; everything else is unchanged.";
    input.changes = input.changes.map((entry) => ({ ...entry, confirmed: true, priceEvidence: "Brightdesk Office price notice, November 1.",
      after: { ...entry.after!, unitPriceCents: NEW_PRICE, taxCents: NEW_TAX, freightCents: 0, currency: "USD" } }));
    const saved = await pricing.saveReview(session, TEST_KEY, { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: workspace.review?.version || null, input });
    const { order } = await pricing.issueReview(session, TEST_KEY, { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    if (confirm) await createApprovalStore(handle.db).decide(session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: "" });
    return order;
  }

  async function payAndHold() {
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
    await holdApprovedItems(handle.db, paypal, session, TEST_KEY);
  }

  it("starts a designer draft from an approved line, once per line", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const { draft } = await change();
    expect(draft).toMatchObject({ model: "designer", basedOnVersion: 1, changes: [{ action: "quantity", itemId: DESK, deltaSubtotalCents: 0 }] });
    expect(draft.changes[0].before).toEqual(draft.changes[0].after);
    expect((await change()).draft.changes).toHaveLength(1);
    expect((await change(TILE)).draft.changes.map((entry) => entry.itemId)).toEqual([DESK, TILE]);
    expect(createPricingInput((await createChatStore(handle.db).getCase(session, TEST_KEY)).quote!, (await change()).draft).source).toEqual({ kind: "client", vendor: "", notice: "" });
  });

  it("refuses lines outside the agreement and projects with nothing approved", async () => {
    await expect(change()).rejects.toMatchObject({ code: "PRICING_NOT_READY", message: expect.stringMatching(/not approved any line/) });
    await signOpeningForTest(handle.db, session, TEST_KEY, testQuote.lines.map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    await expect(change(SOFA)).rejects.toMatchObject({ code: "PRICING_NOT_FOUND", message: expect.stringMatching(/not part of the current agreement/) });
  });

  it("starts a version from a supplier confirmation that differs, with what the supplier confirmed filled in", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const { draft } = await fromSupplier(confirmation());
    expect(draft).toMatchObject({ title: "Updated supplier terms", changes: [{
      action: "quantity", itemId: DESK, after: { quantity: 1, unitPriceCents: NEW_PRICE }, deltaSubtotalCents: 2_500,
      supplier: { reference: "QO-4471", taxCents: NEW_TAX, freightCents: 0, leadTimeDays: 21 },
    }] });
    expect(draft.supplierNotice).toEqual({ vendor: "Brightdesk Office", notice: expect.stringContaining("Brightdesk Office order confirmation QO-4471 for Writing desk: unit price ") });

    const quote = (await createChatStore(handle.db).getCase(session, TEST_KEY)).quote!;
    const input = createPricingInput(quote, draft);
    expect(input.source).toEqual({ kind: "vendor", ...draft.supplierNotice });
    expect(input.terms).toMatch(/follows that confirmation's quantity, unit price, tax and delivery/);
    expect(input.changes).toEqual([expect.objectContaining({ confirmed: false, priceEvidence: expect.stringMatching(/^Supplier order confirmation QO-4471 from /), after: expect.objectContaining({ unitPriceCents: NEW_PRICE, taxCents: NEW_TAX, freightCents: 0, leadTimeDays: 21 }) })]);

    // The designer only confirms the line; the supplier's notice goes to the client as the reason.
    const pricing = createPricingStore(handle.db);
    input.changes = input.changes.map((entry) => ({ ...entry, confirmed: true }));
    const saved = await pricing.saveReview(session, TEST_KEY, { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: null, input });
    const { order } = await pricing.issueReview(session, TEST_KEY, { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    expect(order.source).toEqual({ kind: "vendor", ...draft.supplierNotice });
    expect(order.lines.find((line) => line.itemId === DESK)).toMatchObject({ unitPriceCents: NEW_PRICE, taxCents: NEW_TAX, leadTimeDays: 21 });
  });

  it("refuses a confirmation that matches the line, and opens the started change when asked again", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const same = confirmation({ unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, leadTimeDays: 30 });
    await expect(fromSupplier(same)).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringMatching(/Save the supplier confirmation/) });
    const { draft } = await fromSupplier(confirmation());
    expect((await fromSupplier(confirmation())).draft).toEqual(draft);
    expect((await change()).draft).toEqual(draft);
    await expect(fromSupplier(confirmation({ unitPriceCents: 28_500 }))).rejects.toMatchObject({ code: "PRICING_CONFLICT" });
  });

  it("adds a second supplier's confirmation to the same notice", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await fromSupplier(confirmation());
    // The tile (5 × $45.00 + $18.00 tax, no delivery) now has $25.00 delivery.
    const { draft } = await fromSupplier({ reference: "ST-88", quantity: 5, unitPriceCents: 4_500, taxCents: 1_800, freightCents: 2_500, leadTimeDays: null }, TILE);
    expect(draft.changes.map((entry) => entry.itemId)).toEqual([DESK, TILE]);
    expect(draft.supplierNotice!.vendor).toBe("Brightdesk Office, Stoneware Tile Co");
    expect(draft.supplierNotice!.notice.split("\n")).toEqual([expect.stringContaining("QO-4471"), "Stoneware Tile Co order confirmation ST-88 for Porcelain floor tile: delivery $0.00 → $25.00."]);
  });

  it("keeps a studio draft's reason when a supplier confirmation joins it", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await change(TILE);
    const { draft } = await fromSupplier(confirmation());
    expect(draft.supplierNotice).toBeUndefined();
    const input = createPricingInput((await createChatStore(handle.db).getCase(session, TEST_KEY)).quote!, draft);
    expect(input.source).toEqual({ kind: "client", vendor: "", notice: "" });
    expect(input.changes[1].priceEvidence).toMatch(/^Supplier order confirmation QO-4471/);
  });

  it("shows the supplier's notice to the client and holds the extra amount on saved PayPal once confirmed", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    await payAndHold();
    const v2 = await reprice();
    expect(v2.source).toEqual(NOTICE);
    const state = await createChatStore(handle.db).getCase(session, TEST_KEY);
    expect(state.versions?.at(-1)).toMatchObject({ version: 2, source: NOTICE });
    expect(state.messages.some((message) => message.text.includes("It follows a notice from Brightdesk Office."))).toBe(true);

    const before = (await paymentsWorkspace(handle.db, session, v2.id))!;
    const line = before.lines.find((entry) => entry.itemId === DESK)!;
    const newTotal = 29_700, oldTotal = 27_000; // $275.00 + $22.00 against $250.00 + $20.00
    expect(line).toMatchObject({ targetCents: newTotal, heldCents: oldTotal });
    expect(line.steps.find((step) => step.kind === "authorize")).toMatchObject({ available: false, amountCents: newTotal - oldTotal, note: expect.stringMatching(/saved PayPal/) });

    // What the confirmation request does next: hold the difference with the client's saved PayPal.
    const held = await holdApprovedItems(handle.db, paypal, session, TEST_KEY);
    expect(held).toEqual([expect.objectContaining({ status: "succeeded", amountCents: newTotal - oldTotal, changeOrderId: v2.id })]);
    const after = (await paymentsWorkspace(handle.db, session, v2.id))!.lines.find((entry) => entry.itemId === DESK)!;
    expect(after.heldCents).toBe(newTotal);
    // The four furniture holds of V1, then the desk's difference.
    expect(await handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId))).toHaveLength(5);
  });

  it("changes a line of the latest confirmed version, not V1, once V1 was replaced", async () => {
    await signOpeningForTest(handle.db, session, TEST_KEY);
    // A review saved before the merge may still say "designer"; the version freezes it as the client conversation.
    const v2 = await reprice({ kind: "designer", vendor: "", notice: "" });
    expect(v2.source).toEqual({ kind: "client", vendor: "", notice: "" });
    const { draft } = await change(TILE);
    expect(draft).toMatchObject({ basedOnVersion: 2, changes: [{ itemId: TILE }] });
    const [order] = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.changeOrderId, v2.id));
    expect(order).toBeUndefined();
  });
});
