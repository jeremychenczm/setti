import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paypalAuthorizations, paypalCaptures, paypalRefunds } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { signOpeningForTest } from "../opening/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { addTestProject, CONSULTATION, PLANNING, TEST_KEY } from "../projects/testing";
import { startRefund } from "./actions";
import { completeAuthorization } from "./authorize";
import { businessItem, lockConfirmedVersion } from "./binding";
import { requestRefund } from "./testing/requests";
import { chargeServices, startServicesCheckout } from "./services";
import { confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { links } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

describe.skipIf(!testDatabaseUrl)("refunding one service captured from the shared design-services hold", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v2: FrozenChangeOrder;

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
    await signOpeningForTest(handle.db, session, TEST_KEY);
    const checkout = await startServicesCheckout(handle.db, paypal, session, TEST_KEY, links);
    paypal.approve(checkout.paypalOrderId!);
    await completeAuthorization(handle.db, paypal, checkout.id);
    await chargeServices(handle.db, paypal, session, TEST_KEY);
    // The client paid for two consultation hours (2 × $150.00) and now confirms one hour instead.
    v2 = await confirmChange(handle.db, session, TEST_KEY, {
      action: "quantity", itemId: CONSULTATION, quantity: 1, oldItemHandling: "not_ordered", oldItemCostCents: 0,
    });
  });
  afterAll(() => handle?.pool.end());

  const refund = () => startRefund(handle.db, paypal, session, v2.id, { itemId: CONSULTATION, side: "baseline", ...shown(v2) });
  const line = async () => (await paymentsWorkspace(handle.db, session, v2.id))!.lines.find((entry) => entry.itemId === CONSULTATION)!;
  const refundCalls = () => paypal.calls.filter((call) => "paypalCaptureId" in call && "customId" in call);

  async function scope(quoteItemId = CONSULTATION) {
    const version = await handle.db.transaction((tx) => lockConfirmedVersion(tx, session, v2.id, shown(v2)));
    const itemId = businessItem(version, { itemId: quoteItemId, side: "baseline" });
    const consultationId = businessItem(version, { itemId: CONSULTATION, side: "baseline" });
    const [capture] = await handle.db.select().from(paypalCaptures).where(eq(paypalCaptures.itemId, consultationId));
    return { version, itemId, capture };
  }

  it("refunds the confirmed $150 difference from the consultation's capture once", async () => {
    const { capture } = await scope();
    const [hold] = await handle.db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, capture.authorizationId!));
    expect(hold.itemId).toBeNull();
    expect(capture).toMatchObject({ amountCents: 30_000, status: "completed" });
    expect(await line()).toMatchObject({ targetCents: 15_000, capturedCents: 30_000, refundedCents: 0 });

    const [done] = await refund();
    expect(done).toMatchObject({ status: "succeeded", amountCents: 15_000, captureId: capture.id, itemId: capture.itemId });
    expect(await handle.db.select().from(paypalRefunds)).toEqual([
      expect.objectContaining({ captureId: capture.id, amountCents: 15_000, status: "completed", operationId: done.id }),
    ]);
    expect(await line()).toMatchObject({ capturedCents: 30_000, refundedCents: 15_000, steps: [] });
    expect((await refund()).map((operation) => operation.id)).toEqual([done.id]);
    expect(refundCalls()).toHaveLength(1);
  });

  it("refuses to refund another service from the consultation's capture", async () => {
    const { version, itemId, capture } = await scope(PLANNING);
    await expect(requestRefund(handle.db, {
      businessKey: "test:wrong-service", projectId: version.projectId, captureId: capture.id,
      amountCents: 1_000, binding: version.bind(itemId),
    })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/belongs to another project or item/) });
    expect(await handle.db.select().from(paypalRefunds)).toHaveLength(0);
    expect(refundCalls()).toHaveLength(0);
  });

  it("keeps refunds within this service's capture, including money already refunded", async () => {
    const { version, itemId, capture } = await scope();
    await expect(requestRefund(handle.db, {
      businessKey: "test:above-service-capture", projectId: version.projectId, captureId: capture.id,
      amountCents: capture.amountCents + 1, binding: version.bind(itemId),
    })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/would exceed capture/) });

    await refund();
    await expect(requestRefund(handle.db, {
      businessKey: "test:above-service-remainder", projectId: version.projectId, captureId: capture.id,
      amountCents: 15_001, binding: version.bind(itemId),
    })).rejects.toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringMatching(/would exceed capture/) });
    expect(refundCalls()).toHaveLength(1);
    expect(await handle.db.select().from(paypalRefunds)).toHaveLength(1);
  });
});
