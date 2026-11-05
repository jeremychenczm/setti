import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { chatMessages } from "../chat/schema";
import { items, paymentOperations, paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { attentionView } from "./attention-view";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { runDailyCheck } from "./daily-check";
import { holdApprovedItems } from "./item-holds";
import { itemHoldsView } from "./item-holds-view";
import { lockOpeningVersion } from "./opening";
import { insertOperation } from "./operations";
import { chargeServices, startServicesCheckout } from "./services";
import { recordOpeningSupplierOrder } from "./supplier";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer] = DEMO_ACCOUNTS;
const DAY = 24 * 60 * 60 * 1000;
const DESK = "willow-desk", ARMCHAIR = "willow-armchair", SOFA = "willow-sofa";
const desk = caseDocument("willow").lines.find((line) => line.itemId === DESK)!;
const ITEMS = 19;

/** The database's own refusal, wherever the driver puts its message. */
const databaseRefused = (pattern: RegExp) => (error: unknown) => {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
  return messages.some((message) => pattern.test(message));
};

describe.skipIf(!testDatabaseUrl)("renewing holds that still wait for their supplier", () => {
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
  const check = (days: number) => runDailyCheck(handle.db, paypal, { now: later(days) });
  const holdsOf = async (name: string) => (await handle.db.select({ hold: paypalAuthorizations }).from(paypalAuthorizations)
    .innerJoin(items, eq(items.id, paypalAuthorizations.itemId)).where(and(eq(items.name, name), isNotNull(paypalAuthorizations.itemId))))
    .map(({ hold }) => hold).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const reports = async () => (await handle.db.select().from(chatMessages).where(eq(chatMessages.model, "notice"))).filter((message) => /^Setti (renewed|released|could not renew)/.test(message.text));

  it("renews two days after the notice: a new hold of the same amount first, then the old one is released", async () => {
    expect(await check(23)).toMatchObject({ notices: ITEMS, renewals: 0 });
    expect(await check(24.9)).toMatchObject({ renewals: 0 });
    const run = await check(25.1);
    expect(run).toMatchObject({ renewals: ITEMS, problems: [] });

    const [old, renewed] = await holdsOf("Writing desk");
    expect(old.status).toBe("voided");
    expect(renewed).toMatchObject({ status: "created", amountCents: old.amountCents });
    const operations = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.itemId, old.itemId!));
    const renewal = operations.find((operation) => operation.replacesAuthorizationId === old.id)!;
    const release = operations.find((operation) => operation.kind === "void")!;
    expect(renewal).toMatchObject({ kind: "authorize", status: "succeeded", amountCents: old.amountCents, savedMethodId: expect.any(String) });
    expect(release).toMatchObject({ status: "succeeded", authorizationId: old.id });
    expect(renewal.createdAt.getTime()).toBeLessThanOrEqual(release.createdAt.getTime());

    const [report] = await reports();
    expect(report.text).toMatch(/^Setti renewed 19 holds with Sofia's saved PayPal \(\$[\d,.]+ in all\)\. Nothing was charged; each old hold is released once its new one is in place:\n/);
    expect(report.text).toMatch(/\n• Lounge armchair · \$162\.04 · new \S+ · old \S+ released\n/);

    // The new holds start a new clock: nothing needs the designer today, and a repeat run changes nothing.
    expect((await attentionView(handle.db, session, designer)).items).toEqual([]);
    expect(await check(25.5)).toMatchObject({ renewals: 0, notices: 0 });
    expect(await reports()).toHaveLength(1);
  });

  it("waits two days after a late notice, and never renews an expired hold", async () => {
    expect(await check(26)).toMatchObject({ notices: ITEMS, renewals: 0 });
    expect((await handle.db.select().from(chatMessages).where(eq(chatMessages.model, "notice")))[0].text).toMatch(/On [A-Z][a-z]{2} \d+ Setti will replace each/);
    expect(await check(27.9)).toMatchObject({ renewals: 0 });
    expect(await check(28.1)).toMatchObject({ renewals: ITEMS });

    await truncate(handle.db, "renewal_notices");
    expect(await check(29.5)).toMatchObject({ renewals: 0 });
  });

  it("leaves confirmed and cancelled items alone", async () => {
    const { contentHash } = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
    await recordOpeningSupplierOrder(handle.db, session, "willow", {
      itemId: DESK, contentHash, quantity: desk.quantity, unitPriceCents: desk.unitPriceCents, taxCents: desk.taxCents, freightCents: desk.freightCents,
      inStock: true, leadTimeDays: 10, reference: "QMO-SO-1001", note: "",
    });
    await cancelApprovedItem(handle.db, paypal, session, "willow", { itemId: ARMCHAIR, reason: "no_response", note: "", by: designer.name });
    await check(23);
    expect(await check(25.1)).toMatchObject({ renewals: ITEMS - 2 });
    expect((await holdsOf("Writing desk")).map((hold) => hold.status)).toEqual(["created"]);
  });

  it("keeps the old hold when PayPal refuses the new one, and says so", async () => {
    await check(23);
    // The client removed the PayPal permission on PayPal's side: Setti still thinks the method is saved.
    await paypal.deleteSavedMethod(paypal.savedTokens[0]);
    const run = await check(25.1);
    expect(run.renewals).toBe(0);
    expect(run.problems).toHaveLength(ITEMS);
    expect((await holdsOf("Writing desk")).map((hold) => hold.status)).toEqual(["created"]);
    const line = (await itemHoldsView(handle.db, session, "willow", designer)).items.find((entry) => entry.itemId === DESK)!;
    expect(line).toMatchObject({ state: "held", renewal: { message: expect.any(String) } });
    const reminder = (await attentionView(handle.db, session, designer, later(25.2))).items.find((entry) => entry.itemId === DESK)!;
    expect(reminder).toMatchObject({ kind: "renewal_failed", urgency: "now", detail: expect.stringMatching(/^Setti could not renew the hold: .+ The current hold still ends .+\. Ask the client to approve a new hold, or cancel the item\.$/) });
    expect((await reports())[0].text).toMatch(/^Setti could not renew the hold for Lounge armchair, .+: .+ Their current holds stay as before, and Jordan will follow up\.$/);
  });

  it("tries the release again when it did not go through", async () => {
    await check(23);
    paypal.then("succeed", "reject-over-limit");
    const first = await check(25.1);
    expect(first.renewals).toBe(ITEMS);
    expect(first.problems).toEqual([expect.stringMatching(/was renewed but not released yet/)]);
    const [old, renewed] = await holdsOf("Lounge armchair");
    expect([old.status, renewed.status]).toEqual(["created", "created"]);

    const second = await check(25.2);
    expect(second).toMatchObject({ renewals: 0, problems: [] });
    expect((await holdsOf("Lounge armchair")).map((hold) => hold.status)).toEqual(["voided", "created"]);
    expect((await reports()).at(-1)!.text).toMatch(/^Setti released the old hold \S+ for Lounge armchair, which an earlier renewal replaced\.$/);
  });

  it("refuses a renewal of another item's hold, a second one at a time, or a changed one", async () => {
    const opening = await handle.db.transaction((tx) => lockOpeningVersion(tx, session, "willow", null));
    const [deskHold] = await holdsOf("Writing desk");
    const [armchairHold] = await holdsOf("Lounge armchair");
    const savedMethodId = (await handle.db.select().from(paymentOperations).where(isNotNull(paymentOperations.savedMethodId)))[0].savedMethodId!;
    const renewalOf = (hold: typeof deskHold, itemId = hold.itemId!) => insertOperation(handle.db, {
      businessKey: `test-renew:${randomUUID()}`, projectId: opening.projectId, kind: "authorize", amountCents: hold.amountCents,
      binding: opening.bind(itemId), savedMethodId, replacesAuthorizationId: hold.id, renewedAt: new Date(),
    });
    await expect(renewalOf(deskHold, armchairHold.itemId!)).rejects.toSatisfy(databaseRefused(/same project and item/));
    const created = await renewalOf(deskHold);
    await expect(handle.db.update(paymentOperations).set({ replacesAuthorizationId: armchairHold.id }).where(eq(paymentOperations.id, created.id)))
      .rejects.toSatisfy(databaseRefused(/and when, cannot change/));
    await expect(renewalOf(deskHold)).rejects.toSatisfy(databaseRefused(/unresolved authorization|payment_operations_one_renewal|duplicate key/));
  });
});
