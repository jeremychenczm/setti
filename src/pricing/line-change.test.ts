import { randomUUID } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApprovalStore } from "../approval/store";
import { caseDocument } from "../chat/cases";
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
import { createPricingInput, previewPricing } from "./calculation";
import { startLineChange } from "./line-change";
import { createPricingStore } from "./store";
import type { ChangeSource, FrozenChangeOrder } from "./types";

const DESK = "willow-desk", RUG = "willow-area-rug", SOFA = "willow-sofa";
const desk = caseDocument("willow").lines.find((line) => line.itemId === DESK)!;
const NOTICE: ChangeSource = { kind: "vendor", vendor: "Quillmark Office", notice: "From November 1 the writing desk is $129.99 (was $109.99) because of a lumber surcharge." };

describe.skipIf(!testDatabaseUrl)("the designer changes an approved line", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());

  const change = (itemId = DESK) => startLineChange(handle.db, session, "willow", { itemId });

  /** The designer reprices the desk from the supplier's notice and issues the version; the client confirms it unless told not to. */
  async function reprice(source: ChangeSource = NOTICE, confirm = true): Promise<FrozenChangeOrder> {
    const { draft } = await change();
    const pricing = createPricingStore(handle.db);
    const workspace = await pricing.getWorkspace(session, "willow");
    const quote = (await createChatStore(handle.db).getCase(session, "willow")).quote!;
    const input = createPricingInput(quote, draft);
    input.source = source;
    input.terms = "The desk price follows the supplier's notice; everything else is unchanged.";
    input.changes = input.changes.map((entry) => ({ ...entry, confirmed: true, priceEvidence: "Quillmark Office price notice, November 1.",
      after: { ...entry.after!, unitPriceCents: 12_999, taxCents: 1_137, freightCents: desk.freightCents, currency: "USD" } }));
    const saved = await pricing.saveReview(session, "willow", { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: workspace.review?.version || null, input });
    const { order } = await pricing.issueReview(session, "willow", { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    if (confirm) await createApprovalStore(handle.db).decide(session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: "" });
    return order;
  }

  async function payAndHold() {
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, "willow");
    await holdApprovedItems(handle.db, paypal, session, "willow");
  }

  it("starts a designer draft from an approved line, once per line", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const { draft } = await change();
    expect(draft).toMatchObject({ model: "designer", basedOnVersion: 1, changes: [{ action: "quantity", itemId: DESK, deltaSubtotalCents: 0 }] });
    expect(draft.changes[0].before).toEqual(draft.changes[0].after);
    expect((await change()).draft.changes).toHaveLength(1);
    expect((await change(RUG)).draft.changes.map((entry) => entry.itemId)).toEqual([DESK, RUG]);
    expect(createPricingInput((await createChatStore(handle.db).getCase(session, "willow")).quote!, (await change()).draft).source).toEqual({ kind: "designer", vendor: "", notice: "" });
  });

  it("refuses lines outside the agreement and projects with nothing approved", async () => {
    await expect(change()).rejects.toMatchObject({ code: "PRICING_NOT_FOUND" });
    await signOpeningForTest(handle.db, session, "willow", caseDocument("willow").lines.map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    await expect(change(SOFA)).rejects.toMatchObject({ code: "PRICING_NOT_FOUND", message: expect.stringMatching(/not part of the current agreement/) });
  });

  it("asks for the supplier and its notice before a supplier-notice version can be issued", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const { draft } = await change();
    const quote = (await createChatStore(handle.db).getCase(session, "willow")).quote!;
    const input = createPricingInput(quote, draft);
    input.source = { kind: "vendor", vendor: " ", notice: "" };
    expect(previewPricing(quote, draft, input).problems).toContain("Name the supplier and enter what its notice says, so the client sees why the price changed.");
  });

  it("shows the supplier's notice to the client and holds the extra amount on saved PayPal once confirmed", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    await payAndHold();
    const v2 = await reprice();
    expect(v2.source).toEqual(NOTICE);
    const state = await createChatStore(handle.db).getCase(session, "willow");
    expect(state.versions?.at(-1)).toMatchObject({ version: 2, source: NOTICE });
    expect(state.messages.some((message) => message.text.includes("It follows a notice from Quillmark Office."))).toBe(true);

    const before = (await paymentsWorkspace(handle.db, session, v2.id))!;
    const line = before.lines.find((entry) => entry.itemId === DESK)!;
    const newTotal = 12_999 + 1_137 + desk.freightCents, oldTotal = desk.unitPriceCents + desk.taxCents + desk.freightCents;
    expect(line).toMatchObject({ targetCents: newTotal, heldCents: oldTotal });
    expect(line.steps.find((step) => step.kind === "authorize")).toMatchObject({ available: false, amountCents: newTotal - oldTotal, note: expect.stringMatching(/saved PayPal/) });

    // What the confirmation request does next: hold the difference with the client's saved PayPal.
    const held = await holdApprovedItems(handle.db, paypal, session, "willow");
    expect(held).toEqual([expect.objectContaining({ status: "succeeded", amountCents: newTotal - oldTotal, changeOrderId: v2.id })]);
    const after = (await paymentsWorkspace(handle.db, session, v2.id))!.lines.find((entry) => entry.itemId === DESK)!;
    expect(after.heldCents).toBe(newTotal);
    expect(await handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId))).toHaveLength(caseDocument("willow").lines.filter((entry) => entry.category === "furniture").length + 1);
  });

  it("changes a line of the latest confirmed version, not V1, once V1 was replaced", async () => {
    await signOpeningForTest(handle.db, session, "willow");
    const v2 = await reprice({ kind: "designer", vendor: "", notice: "" });
    expect(v2.source).toEqual({ kind: "designer", vendor: "", notice: "" });
    const { draft } = await change(RUG);
    expect(draft).toMatchObject({ basedOnVersion: 2, changes: [{ itemId: RUG }] });
    const [order] = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.changeOrderId, v2.id));
    expect(order).toBeUndefined();
  });
});
