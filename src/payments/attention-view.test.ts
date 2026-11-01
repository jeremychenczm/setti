import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { attentionView } from "./attention-view";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { holdApprovedItems } from "./item-holds";
import { lockOpeningVersion } from "./opening";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer, client] = DEMO_ACCOUNTS;
const DAY = 24 * 60 * 60 * 1000;
const DESK = "willow-desk", ARMCHAIR = "willow-armchair", SOFA = "willow-sofa";
const desk = caseDocument("willow").lines.find((line) => line.itemId === DESK)!;

describe.skipIf(!testDatabaseUrl)("the designer's reminders from recorded holds", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
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

  const later = (days: number) => new Date(Date.now() + days * DAY);
  const reminders = async (days: number, account = designer) => (await attentionView(handle.db, session, account, later(days))).items;

  it("asks about every unconfirmed hold after a day, and follows what the designer does", async () => {
    expect(await reminders(0)).toEqual([]);
    const tomorrow = await reminders(1.5);
    expect(tomorrow.length).toBe(21);
    expect(tomorrow.every((entry) => entry.kind === "supplier_unconfirmed" && entry.projectName === "Willow Residence")).toBe(true);
    expect(tomorrow.find((entry) => entry.itemId === DESK)).toMatchObject({ href: "/quotes/willow?hold=willow-desk#item-holds", detail: expect.stringMatching(/hold day 2 of 3/) });

    const { contentHash } = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
    await recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    });
    await cancelApprovedItem(handle.db, paypal, session, "willow", { itemId: ARMCHAIR, reason: "no_response", note: "", by: designer.name });
    const after = await reminders(1.5);
    expect(after.length).toBe(20);
    expect(after.find((entry) => entry.itemId === ARMCHAIR)).toBeUndefined();
    expect(after.find((entry) => entry.itemId === DESK)).toMatchObject({ kind: "capture_ready" });
  });

  it("warns before the holds expire and says Setti renews them with the saved method", async () => {
    const soon = await reminders(23);
    expect(soon.length).toBe(21);
    expect(soon.every((entry) => entry.kind === "expiring" && /Setti renews it on .+ with the client's saved payment method/.test(entry.detail))).toBe(true);
  });

  it("shows the client nothing: these are the studio's reminders", async () => {
    expect(await reminders(1.5, client)).toEqual([]);
    expect((await attentionView(handle.db, null, designer, later(1.5))).items).toEqual([]);
  });
});
