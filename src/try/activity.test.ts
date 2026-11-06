import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { caseDocument } from "../chat/cases";
import { chatMessages } from "../chat/schema";
import { demoActivity, itemCancellations, paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "../payments/authorize";
import { runDailyCheck } from "../payments/daily-check";
import { holdApprovedItems } from "../payments/item-holds";
import { chargeServices, startServicesCheckout } from "../payments/services";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { closeIdleDemos, demoEnd, demoEndedNotice, endDemo, noteActivity } from "./activity";

const DAY = 24 * 60 * 60 * 1000;
const ITEMS = 20;

describe("the notice when a demo ends", () => {
  it("says why it ended, what was released and that charges stay", () => {
    const at = new Date("2026-11-13T15:00:00Z");
    expect(demoEndedNotice({ reason: "idle", at, items: 4, heldCents: 553_000 })).toBe(
      "This demo ended on November 13, 2026, after 7 days without activity. Setti cancelled the 4 items still on hold and asked PayPal to release $5,530.00; nothing was charged for them. Payments already charged stay as they are. This project stays here as a record; to try Setti again, start a new demo from /try.");
    expect(demoEndedNotice({ reason: "visitor", at, items: 1, heldCents: 10_000 })).toMatch(/^This demo was ended with End demo & reset on November 13, 2026\. Setti cancelled the 1 item still on hold/);
  });
});

describe.skipIf(!testDatabaseUrl)("ending a demo", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "hold_checks", "renewal_notices", "demo_activity");
    session = randomUUID();
    paypal = new FakePayPal();
    await signOpeningForTest(handle.db, session, "willow", caseDocument("willow").lines.map((line) => ({ itemId: line.itemId, decision: "approved" as const })));
    const checkout = await startServicesCheckout(handle.db, paypal, session, "willow", links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, "willow");
    await holdApprovedItems(handle.db, paypal, session, "willow");
  });
  afterAll(() => handle?.pool.end());

  const later = (days: number) => new Date(Date.now() + days * DAY);
  const openItemHolds = () => handle.db.select().from(paypalAuthorizations)
    .where(and(isNotNull(paypalAuthorizations.itemId), inArray(paypalAuthorizations.status, ["created", "partially_captured"])));
  const notices = () => handle.db.select().from(chatMessages).where(eq(chatMessages.model, "notice"));

  it("notes use at most once an hour, and not after the demo ended", async () => {
    const start = new Date("2026-11-06T10:00:00Z");
    const lastUse = async () => (await handle.db.select().from(demoActivity).where(eq(demoActivity.sessionId, session)))[0].lastActiveAt.toISOString();
    await noteActivity(handle.db, session, start);
    await noteActivity(handle.db, session, new Date(start.getTime() + 30 * 60_000));
    expect(await lastUse()).toBe(start.toISOString());
    await noteActivity(handle.db, session, new Date(start.getTime() + 2 * 60 * 60_000));
    expect(await lastUse()).toBe("2026-11-06T12:00:00.000Z");
    await endDemo(handle.db, paypal, session, "visitor", new Date("2026-11-06T13:00:00Z"));
    await noteActivity(handle.db, session, new Date("2026-11-07T10:00:00Z"));
    expect(await lastUse()).toBe("2026-11-06T12:00:00.000Z");
  });

  it("leaves a demo used within the week alone", async () => {
    await noteActivity(handle.db, session, later(2));
    expect(await closeIdleDemos(handle.db, paypal, later(8))).toEqual({ ended: 0, released: 0, problems: [] });
    expect(await demoEnd(handle.db, session)).toBeNull();
    expect(await openItemHolds()).toHaveLength(ITEMS);
  });

  it("ends a demo unused for a week: cancels what is held, releases it on PayPal and tells both people once", async () => {
    // No activity was noted, so the week counts from when the project was opened.
    const result = await closeIdleDemos(handle.db, paypal, later(8));
    expect(result).toEqual({ ended: 1, released: ITEMS, problems: [] });
    expect(await demoEnd(handle.db, session)).toMatchObject({ reason: "idle" });
    expect(await openItemHolds()).toHaveLength(0);
    const cancellations = await handle.db.select().from(itemCancellations);
    expect(cancellations).toHaveLength(ITEMS);
    expect(cancellations.every((entry) => entry.reason === "demo_ended" && entry.cancelledBy === "Setti")).toBe(true);
    const posted = await notices();
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toMatch(new RegExp(`after 7 days without activity\\. Setti cancelled the ${ITEMS} items still on hold and asked PayPal to release \\$`));
    // Nothing designer-voiced is posted per item.
    expect((await handle.db.select().from(chatMessages).where(eq(chatMessages.actor, "designer"))).filter((message) => /I've cancelled it/.test(message.text))).toHaveLength(0);

    expect(await closeIdleDemos(handle.db, paypal, later(9))).toEqual({ ended: 0, released: 0, problems: [] });
    expect(await notices()).toHaveLength(1);
  });

  it("finishes releasing an ended demo in the next daily check, and gives it no notices or renewals", async () => {
    paypal.then(...Array.from({ length: ITEMS }, () => "reject-over-limit" as const));
    const first = await endDemo(handle.db, paypal, session, "visitor", later(0));
    expect(first.ended).toBe(true);
    expect(first.released).toBe(0);
    expect(first.problems.length).toBeGreaterThan(0);
    expect(await openItemHolds()).toHaveLength(ITEMS);

    const check = await runDailyCheck(handle.db, paypal, { now: later(23) });
    expect(check).toMatchObject({ endedDemos: 0, notices: 0, renewals: 0, problems: [] });
    expect(await openItemHolds()).toHaveLength(0);
    expect((await notices()).map((notice) => notice.text)).toEqual([expect.stringMatching(/^This demo was ended with End demo & reset/)]);
  });
});
