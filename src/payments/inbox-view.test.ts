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
import { cancelApprovedItem } from "./cancel-item";
import type { AttentionItem } from "./attention";
import { inboxBadge, inboxFacts, inboxView, markInboxOpened, type InboxView } from "./inbox-view";
import { holdApprovedItems } from "./item-holds";
import { chargeServices, startServicesCheckout } from "./services";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";

const [designer, client] = DEMO_ACCOUNTS;
const ITEMS = 19;

describe.skipIf(!testDatabaseUrl)("the payment inbox", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "hold_checks", "renewal_notices", "demo_clocks", "inbox_reads");
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
    // The total, the items that share a state, then where each item stands now, then the newest twenty records as history.
    const groups = facts.filter((fact) => fact.id.startsWith("group-"));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.text).toMatch(/^Now · (\d+) items (?:on hold|charged, with nothing on hold): .+; and \d+ more\.$|^Now · [2-5] items (?:on hold|charged, with nothing on hold): [^.]+\.$/);
    expect(facts.filter((fact) => fact.id.startsWith("now-")).map((fact) => fact.items)).toEqual(view.items.map((item) => [item.label]));
    expect(facts.length).toBe(1 + groups.length + view.items.length + Math.min(20, view.events.length));
    expect(facts.at(-1)!.text).toMatch(/^Earlier · /);
  });

  it("shows the designer the reminders of every project, on the session's clock", async () => {
    expect((await inboxView(handle.db, null, session, designer)).reminders).toEqual([]);
    expect(inboxFacts(await inboxView(handle.db, null, session, designer))).toEqual([]);
    await skipAhead(handle.db, paypal, session, 3);
    const view = await inboxView(handle.db, null, session, designer);
    expect(view).toMatchObject({ role: "designer", reader: "Jordan", simulatedDays: 3, events: [], project: null });
    expect(view.reminders).toHaveLength(ITEMS);
    // One kind of reminder in one project: the total names three of them and counts the rest, and no group repeats it.
    const facts = inboxFacts(view);
    expect(facts[0]).toEqual({ id: "reminders", text: expect.stringMatching(/^19 reminders across 1 project\(s\); 19 to handle today\. They are for [^;]+; [^;]+; [^;]+; and 16 more\.$/), items: view.reminders.map((item) => item.itemLabel) });
    expect(facts.some((fact) => fact.id.startsWith("group:"))).toBe(false);
  });

  it("counts the client's money records not seen yet, and after a visit only newer ones", async () => {
    // Never opened: everything in it is new.
    const first = await inboxView(handle.db, null, session, client);
    expect(first.events.length).toBeGreaterThan(ITEMS);
    expect(first.unread).toEqual(first.events.map((event) => event.id));
    expect(first.opened).toBe(false);
    expect(await inboxBadge(handle.db, session, client)).toEqual({ role: "client", count: first.events.length, opened: false });

    await markInboxOpened(handle.db, session, client, new Date(first.readAt));
    expect(await inboxBadge(handle.db, session, client)).toEqual({ role: "client", count: 0, opened: true });
    // An older open tab cannot make seen records new again.
    await markInboxOpened(handle.db, session, client, new Date(Date.parse(first.readAt) - 60_000));
    expect((await inboxView(handle.db, null, session, client)).unread).toEqual([]);

    await cancelApprovedItem(handle.db, paypal, session, "willow", { itemId: "willow-desk", reason: "unavailable", note: "", by: designer.name });
    const after = await inboxView(handle.db, null, session, client);
    const released = after.events.filter((event) => event.kind === "released");
    expect(released).toHaveLength(1);
    expect(after.unread).toEqual([released[0].id]);
    expect(await inboxBadge(handle.db, session, client)).toEqual({ role: "client", count: 1, opened: true });
  });

  it("keeps counting the designer's open reminders after a visit, and marks only unseen ones new", async () => {
    await skipAhead(handle.db, paypal, session, 3);
    const view = await inboxView(handle.db, null, session, designer);
    expect(view.unread).toEqual(view.reminders.map((item) => item.id));
    await markInboxOpened(handle.db, session, designer, new Date(view.readAt));
    expect((await inboxView(handle.db, null, session, designer)).unread).toEqual([]);
    // Seen is not handled: the reminders still need doing.
    expect(await inboxBadge(handle.db, session, designer)).toEqual({ role: "designer", count: ITEMS, opened: true });
    // Each account keeps its own read marker.
    expect((await inboxView(handle.db, null, session, client)).unread.length).toBeGreaterThan(0);
  });
});

describe("the facts a designer's summary names items from", () => {
  const reminder = (itemLabel: string, kind: AttentionItem["kind"]): AttentionItem => ({
    id: `maple:baseline:${itemLabel}:${kind}`, kind, projectKey: "maple", projectName: "Maple Ave Café", itemId: itemLabel, side: "baseline", itemLabel,
    title: `${itemLabel} · ${kind}`, detail: "Do the next step.", urgency: "now", href: "/quotes/maple",
  });
  const view = (reminders: AttentionItem[]) => ({ role: "designer", reminders, events: [], items: [], totals: null, project: null, unread: [] }) as unknown as InboxView;

  it("counts and names each group of reminders that share a state: all of up to five, or three and how many more", () => {
    const notOrdered = ["Counter stool", "Oak window counter", "Acoustic ceiling panel", "Counter pendant light", "Back bar wall tile", "Bar shelf", "Menu board"];
    const facts = inboxFacts(view([reminder("Quartz countertop", "capture_ready"), reminder("Floor lamp", "capture_ready"), ...notOrdered.map((label) => reminder(label, "not_ordered")), reminder("Sofa", "expiring")]));
    expect(facts[0]).toMatchObject({ id: "reminders", text: "10 reminders across 1 project(s); 10 to handle today. They are for Quartz countertop; Floor lamp; Counter stool; and 7 more." });
    expect(facts.filter((fact) => fact.id.startsWith("group:"))).toEqual([
      { id: "group:maple:capture_ready", text: "Maple Ave Café · 2 items ready to capture: Quartz countertop; Floor lamp.", items: ["Quartz countertop", "Floor lamp"] },
      { id: "group:maple:not_ordered", text: "Maple Ave Café · 7 items not ordered yet: Counter stool; Oak window counter; Acoustic ceiling panel; and 4 more.", items: notOrdered },
    ]);
  });
});
