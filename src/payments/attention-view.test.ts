import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, CHAIR, DESK, SOFA, TEST_KEY, testClient as client, testDesigner as designer, testLine, testQuote, TILE } from "../projects/testing";
import { attentionView } from "./attention-view";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { holdApprovedItems } from "./item-holds";
import { lockOpeningVersion } from "./opening";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const DAY = 24 * 60 * 60 * 1000;
const desk = testLine(DESK);

describe.skipIf(!testDatabaseUrl)("the designer's reminders from recorded holds", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    // Every line approved except the sofa; the services are paid and the chair, desk and tile held.
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

  const later = (days: number) => new Date(Date.now() + days * DAY);
  const reminders = async (days: number, account = designer) => (await attentionView(handle.db, session, account, later(days))).items;

  it("reminds about every item still only held after three days, and follows what the designer does", async () => {
    expect(await reminders(0)).toEqual([]);
    expect(await reminders(2.5)).toEqual([]);
    const tomorrow = await reminders(3.5);
    expect(tomorrow.map((entry) => entry.itemId).sort()).toEqual([CHAIR, DESK, TILE].sort());
    expect(tomorrow.every((entry) => entry.kind === "not_ordered" && entry.projectName === "Fernhill Apartment")).toBe(true);
    expect(tomorrow.find((entry) => entry.itemId === DESK)).toMatchObject({ href: "/quotes/fernhill?v=1&hold=fernhill-desk#item-holds", detail: expect.stringMatching(/^Approved and held for 3 days/) });

    const { contentHash } = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, TEST_KEY, null));
    await recordOpeningSupplierOrder(handle.db, session, TEST_KEY, {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "BD-SO-1001", note: "",
    });
    await cancelApprovedItem(handle.db, paypal, session, TEST_KEY, { itemId: CHAIR, reason: "no_response", note: "", by: designer.name });
    const after = await reminders(3.5);
    expect(after.map((entry) => [entry.itemId, entry.kind]).sort()).toEqual([[DESK, "capture_ready"], [TILE, "not_ordered"]]);
  });

  it("warns before the holds expire and says Setti renews them with the saved method", async () => {
    const soon = await reminders(23);
    expect(soon.length).toBe(3);
    expect(soon.every((entry) => entry.kind === "expiring" && /Setti renews it on .+ with the client's saved payment method/.test(entry.detail))).toBe(true);
  });

  it("shows the client nothing: these are the studio's reminders", async () => {
    expect(await reminders(3.5, client)).toEqual([]);
    expect((await attentionView(handle.db, null, designer, later(3.5))).items).toEqual([]);
  });
});
