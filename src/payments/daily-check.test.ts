import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { chatMessages } from "../chat/schema";
import { holdChecks, items, paypalAuthorizations, renewalNotices } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { attentionView } from "./attention-view";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { lastDailyCheck, runDailyCheck } from "./daily-check";
import { holdApprovedItems } from "./item-holds";
import { lockOpeningVersion } from "./opening";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer] = DEMO_ACCOUNTS;
const DAY = 24 * 60 * 60 * 1000;
const DESK = "willow-desk", ARMCHAIR = "willow-armchair", SOFA = "willow-sofa";
const desk = caseDocument("willow").lines.find((line) => line.itemId === DESK)!;
const ITEMS = 21;

describe.skipIf(!testDatabaseUrl)("the daily check", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "hold_checks", "renewal_notices");
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
  const check = (days: number, sessionId?: string) => runDailyCheck(handle.db, paypal, { now: later(days), ...(sessionId ? { sessionId } : {}) });
  const notices = () => handle.db.select().from(chatMessages).where(eq(chatMessages.model, "notice"));
  const holdOf = async (name: string) => (await handle.db.select({ hold: paypalAuthorizations }).from(paypalAuthorizations)
    .innerJoin(items, eq(items.id, paypalAuthorizations.itemId)).where(and(eq(items.name, name), isNotNull(paypalAuthorizations.itemId))))[0].hold;

  it("announces each hold once in its last week, in one notice per project, and records the run", async () => {
    expect(await check(21)).toMatchObject({ holds: ITEMS, notices: 0, readbacks: [], problems: [] });
    expect(await check(23)).toMatchObject({ holds: ITEMS, notices: ITEMS, problems: [] });
    const posted = await notices();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ actor: "assistant", replyToMessageId: null });
    expect(posted[0].text).toMatch(/^Heads-up for Sofia and Jordan: 21 holds end .+, because PayPal holds last 29 days, and their suppliers haven't confirmed the orders yet:/);
    expect(posted[0].text).toMatch(/• and 13 more: /);
    expect(posted[0].text).toMatch(/Setti will replace each with a new hold of the same amount on Sofia's saved PayPal \(\$[\d,.]+ in all\), so nothing is charged and Sofia doesn't need to do anything\. If the project or any of these items has stopped, Jordan can cancel those holds before then\.$/);
    expect(await handle.db.select().from(renewalNotices)).toHaveLength(ITEMS);
    // The same day again announces nothing new.
    expect((await check(23.5)).notices).toBe(0);
    expect(await notices()).toHaveLength(1);
    expect(await handle.db.select().from(holdChecks)).toHaveLength(3);
    expect(await lastDailyCheck(handle.db, session)).toMatchObject({ problems: [] });
    expect((await attentionView(handle.db, session, designer)).lastCheck).toMatchObject({ problems: [] });
  });

  it("leaves out items the designer already settled", async () => {
    const { contentHash } = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
    await recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    });
    await cancelApprovedItem(handle.db, paypal, session, "willow", { itemId: ARMCHAIR, reason: "no_response", note: "", by: designer.name });
    expect((await check(23)).notices).toBe(ITEMS - 2);
    const [notice] = await notices();
    expect(notice.text).toMatch(/^Heads-up for Sofia and Jordan: 19 holds end/);
    expect(notice.text.includes("Writing desk") || notice.text.includes("Lounge armchair")).toBe(false);
  });

  it("asks PayPal about holds past their 29 days, and records only what PayPal confirms", async () => {
    // Sandbox holds never expire by themselves: PayPal still reports them held.
    const first = await check(30);
    expect(first).toMatchObject({ holds: ITEMS, notices: 0, problems: [] });
    expect(first.readbacks).toHaveLength(ITEMS);
    expect(first.readbacks.every((entry) => entry.outcome === "still_held" && entry.paypalStatus === "CREATED")).toBe(true);
    expect((await holdOf("Writing desk")).status).toBe("created");

    // PayPal says one expired: the record follows, and the reminder says so.
    const deskHold = await holdOf("Writing desk");
    paypal.hold(deskHold.paypalAuthorizationId)!.status = "EXPIRED";
    const second = await check(30);
    expect(second.readbacks.find((entry) => entry.paypalAuthorizationId === deskHold.paypalAuthorizationId)).toMatchObject({ outcome: "expired", paypalStatus: "EXPIRED" });
    expect((await holdOf("Writing desk")).status).toBe("expired");
    expect((await check(31)).holds).toBe(ITEMS - 1);

    // PayPal cannot be reached: a problem of the run, never "fine".
    paypal.readsUnavailable = true;
    const third = await check(31);
    expect(third.readbacks.every((entry) => entry.outcome === "unreadable")).toBe(true);
    expect(third.problems).toHaveLength(ITEMS - 1);
    expect((await attentionView(handle.db, session, designer)).lastCheck!.problems).toHaveLength(ITEMS - 1);
  });

  it("checks only one demo session when asked to", async () => {
    expect(await check(23, randomUUID())).toMatchObject({ holds: 0, notices: 0 });
    expect(await notices()).toHaveLength(0);
    expect(await lastDailyCheck(handle.db, session)).toBeNull();
    expect((await check(23, session)).notices).toBe(ITEMS);
    expect(await notices()).toHaveLength(1);
  });
});
