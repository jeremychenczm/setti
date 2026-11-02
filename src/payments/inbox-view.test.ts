import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { paypalCalls } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { skipAhead } from "../try/clock";
import { completeAuthorization } from "./authorize";
import { inboxFacts, inboxView } from "./inbox-view";
import { holdApprovedItems } from "./item-holds";
import { chargeServices, startServicesCheckout } from "./services";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer, client] = DEMO_ACCOUNTS;
const ITEMS = 21;

describe.skipIf(!testDatabaseUrl)("the payment inbox", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "hold_checks", "renewal_notices", "demo_clocks");
    session = randomUUID();
    paypal = new FakePayPal();
    await signOpeningForTest(handle.db, session, "willow", caseDocument("willow").lines.map((line) => line.itemId === "willow-sofa"
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const }));
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, "willow");
    await holdApprovedItems(handle.db, paypal, session, "willow");
  });
  afterAll(() => handle?.pool.end());

  it("shows the client every charge and hold, read back from PayPal first", async () => {
    const view = await inboxView(handle.db, paypal, session, client);
    expect(view).toMatchObject({ role: "client", reader: "Sofia", project: { key: "willow", name: "Willow Residence" }, reminders: [] });
    const held = view.events.filter((event) => event.kind === "held");
    const charged = view.events.filter((event) => event.kind === "charged");
    expect(held).toHaveLength(ITEMS);
    expect(charged.length).toBeGreaterThan(0);
    expect(charged.every((event) => event.itemLabel !== "An item")).toBe(true);
    expect(view.totals!.heldCents).toBe(held.reduce((total, event) => total + event.amountCents, 0));
    expect(view.totals!.chargedCents).toBe(charged.reduce((total, event) => total + event.amountCents, 0));
    // The eight newest were read back from PayPal and say so; the rest keep PayPal's response to the step.
    expect(view.events.filter((event) => event.checked?.via === "readback")).toHaveLength(8);
    expect(view.events.every((event) => event.checked)).toBe(true);
    const reads = await handle.db.select().from(paypalCalls).where(eq(paypalCalls.step, "get_authorization"));
    expect(reads.length).toBeGreaterThan(0);
    // A second view within ten minutes reads the next ones, not the same ones again.
    const again = await inboxView(handle.db, paypal, session, client);
    expect(again.events.filter((event) => event.checked?.via === "readback")).toHaveLength(16);

    const facts = inboxFacts(view);
    expect(facts[0]).toMatchObject({ id: "money-now", text: expect.stringMatching(/^In Willow Residence: \$[\d,.]+ charged in total, \$[\d,.]+ on hold now, \$0\.00 refunded in total\.$/) });
    expect(facts.length).toBe(21);
  });

  it("shows the designer the reminders of every project, on the session's clock", async () => {
    expect((await inboxView(handle.db, null, session, designer)).reminders).toEqual([]);
    expect(inboxFacts(await inboxView(handle.db, null, session, designer))).toEqual([]);
    await skipAhead(handle.db, paypal, session, 3);
    const view = await inboxView(handle.db, null, session, designer);
    expect(view).toMatchObject({ role: "designer", reader: "Jordan", simulatedDays: 3, events: [], project: null });
    expect(view.reminders).toHaveLength(ITEMS);
    expect(inboxFacts(view)[0]).toEqual({ id: "reminders", text: "21 reminders across 1 project(s); 21 to handle today." });
  });
});
