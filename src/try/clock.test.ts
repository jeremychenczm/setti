import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { chatMessages } from "../chat/schema";
import { holdChecks } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { attentionView } from "../payments/attention-view";
import { completeAuthorization } from "../payments/authorize";
import { holdApprovedItems } from "../payments/item-holds";
import { itemHoldsView } from "../payments/item-holds-view";
import { chargeServices, startServicesCheckout } from "../payments/services";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { demoDays, DemoClockError, skipAhead } from "./clock";

const [designer] = DEMO_ACCOUNTS;
const ITEMS = 19;

describe.skipIf(!testDatabaseUrl)("a demo session's simulated time", () => {
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

  it("judges the session's reminders by its clock", async () => {
    expect((await itemHoldsView(handle.db, session, "willow", designer)).clock.simulatedDays).toBe(0);
    expect((await attentionView(handle.db, session, designer)).items).toEqual([]);

    expect(await skipAhead(handle.db, paypal, session, 2)).toMatchObject({ days: 2, runs: [expect.anything(), expect.anything()] });
    expect((await attentionView(handle.db, session, designer)).items).toEqual([]);
    await skipAhead(handle.db, paypal, session, 3);
    expect(await demoDays(handle.db, session)).toBe(3);
    const reminders = await attentionView(handle.db, session, designer);
    expect(reminders.simulatedDays).toBe(3);
    expect(reminders.items).toHaveLength(ITEMS);
    expect(reminders.items.every((entry) => entry.kind === "not_ordered" && /^Approved and held for 3 days/.test(entry.detail))).toBe(true);
    expect((await itemHoldsView(handle.db, session, "willow", designer)).clock.simulatedDays).toBe(3);
  });

  it("runs the daily check for each day it skips: the notice on day 22, the renewal on day 25", async () => {
    await skipAhead(handle.db, paypal, session, 2);
    const { days, runs } = await skipAhead(handle.db, paypal, session, 26);
    expect(days).toBe(26);
    expect(runs).toHaveLength(24);
    const noticeDay = runs.findIndex((run) => run.notices > 0) + 3;
    const renewalDay = runs.findIndex((run) => run.renewals > 0) + 3;
    expect([noticeDay, renewalDay]).toEqual([22, 25]);
    expect(runs.reduce((total, run) => total + run.renewals, 0)).toBe(ITEMS);
    expect(await handle.db.select().from(holdChecks).where(eq(holdChecks.sessionId, session))).toHaveLength(26);
    const notices = (await handle.db.select().from(chatMessages).where(eq(chatMessages.model, "notice"))).map((message) => message.text);
    expect(notices).toEqual([expect.stringMatching(/^Heads-up for Sofia and Jordan: 19 holds end/), expect.stringMatching(/^Setti renewed 19 holds/)]);
    const armchair = (await itemHoldsView(handle.db, session, "willow", designer)).items.find((line) => line.itemId === "willow-armchair")!;
    expect(armchair).toMatchObject({ state: "held", timing: { renewed: true } });
  });

  it("only moves forward, by whole days, up to day 30", async () => {
    await skipAhead(handle.db, paypal, session, 3);
    expect(await skipAhead(handle.db, paypal, session, 2)).toMatchObject({ days: 3, runs: [] });
    await expect(skipAhead(handle.db, paypal, session, 31)).rejects.toBeInstanceOf(DemoClockError);
    await expect(skipAhead(handle.db, paypal, session, 2.5)).rejects.toBeInstanceOf(DemoClockError);
    expect(await demoDays(handle.db, session)).toBe(3);
    expect(await demoDays(handle.db, randomUUID())).toBe(0);
  });
});
