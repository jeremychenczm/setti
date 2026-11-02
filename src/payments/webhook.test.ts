import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import { paymentOperations, paypalAuthorizations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import { completeAuthorization } from "./authorize";
import { cancelApprovedItem } from "./cancel-item";
import { holdApprovedItems } from "./item-holds";
import { moneyEvents } from "./money-events";
import { chargeServices, startServicesCheckout } from "./services";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";
import { recordWebhookEvent } from "./webhook";

const [designer] = DEMO_ACCOUNTS;

describe.skipIf(!testDatabaseUrl)("PayPal webhook events", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "paypal_webhook_events");
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

  const event = (type: string, resourceId: string, status: string, value = "119.61") => ({ id: `WH-${randomUUID()}`, event_type: type, create_time: "2026-11-01T20:00:00Z", resource: { id: resourceId, status, amount: { value, currency_code: "USD" } } });

  it("keeps each event once, matched to the step it confirms, and shows it as confirmed by PayPal", async () => {
    // An item's hold: the design-services hold is shown through its charges instead.
    const hold = (await handle.db.select().from(paypalAuthorizations)).find((entry) => entry.itemId)!;
    const created = event("PAYMENT.AUTHORIZATION.CREATED", hold.paypalAuthorizationId, "CREATED");
    const first = await recordWebhookEvent(handle.db, created);
    expect(first).toEqual({ stored: true, operationId: hold.operationId });
    expect(await recordWebhookEvent(handle.db, created)).toEqual({ stored: false, operationId: hold.operationId });

    const held = (await moneyEvents(handle.db, session, "willow")).find((entry) => entry.id === hold.operationId)!;
    expect(held.checked).toMatchObject({ via: "webhook", status: "CREATED" });
  });

  it("matches a voided hold to its release, and keeps events about nothing Setti knows", async () => {
    await cancelApprovedItem(handle.db, paypal, session, "willow", { itemId: "willow-desk", reason: "unavailable", note: "", by: designer.name });
    const [release] = await handle.db.select().from(paymentOperations).where(eq(paymentOperations.kind, "void"));
    const voided = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, release.authorizationId!));
    expect(await recordWebhookEvent(handle.db, event("PAYMENT.AUTHORIZATION.VOIDED", voided[0].paypalAuthorizationId, "VOIDED"))).toMatchObject({ stored: true, operationId: release.id });
    expect(await recordWebhookEvent(handle.db, event("PAYMENT.CAPTURE.COMPLETED", "UNKNOWN-CAPTURE", "COMPLETED"))).toEqual({ stored: true, operationId: null });
    await expect(recordWebhookEvent(handle.db, { event_type: "PAYMENT.CAPTURE.COMPLETED" })).rejects.toThrow(/needs an id and a type/);
  });
});
