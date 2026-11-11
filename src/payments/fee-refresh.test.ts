import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paymentOperations, paypalCaptures, paypalRefunds } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import type { FrozenChangeOrder } from "../pricing/types";
import { addTestProject, TEST_KEY } from "../projects/testing";
import { startCapture, startRefund } from "./actions";
import { refreshRecordedFees } from "./fee-refresh";
import { summarizePaymentFees } from "./fee-summary";
import type { CaptureReceipt, PayPalResult, RefundReceipt, ReportedSettlement } from "./paypal";
import { paypalCalls } from "./schema";
import { recordSupplierCredit } from "./supplier";
import { confirmChange, shown } from "./testing/cases";
import { FakePayPal } from "./testing/fake-paypal";
import { CHAIR, confirmSupplier, sixChairsHeld } from "./testing/flows";
import { paymentsWorkspace } from "./workspace";

const usd = (amountCents: number) => ({ amountCents, currency: "USD" });
const breakdown = (grossCents: number, feeCents: number): ReportedSettlement => ({ gross: usd(grossCents), fee: usd(feeCents), net: usd(grossCents - feeCents), platformFeesPresent: false, conversionPresent: false });
const captureFee = (grossCents: number) => Math.round(grossCents * 0.0349) + 49;

describe.skipIf(!testDatabaseUrl)("reading PayPal fees for completed captures and refunds", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  let v4: FrozenChangeOrder;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
    paypal = new FakePayPal();
    await addTestProject(handle.db, session);
    const { v3 } = await sixChairsHeld(handle.db, paypal, session);
    await confirmSupplier(handle.db, session, v3, "baseline");
    await startCapture(handle.db, paypal, session, v3.id, { itemId: CHAIR, side: "baseline", ...shown(v3) });
    v4 = await confirmChange(handle.db, session, TEST_KEY, { action: "remove", itemId: CHAIR, oldItemHandling: "returned", oldItemCostCents: 2_500 });
    const line = { itemId: CHAIR, side: "baseline" as const, ...shown(v4) };
    await recordSupplierCredit(handle.db, session, v4.id, { ...line, creditCents: 79_063, reference: "DEMO-CREDIT-1", note: "Demo supplier credit entered by the designer." });
    await startRefund(handle.db, paypal, session, v4.id, line);
  });
  afterAll(() => handle?.pool.end());

  /** Answers like PayPal's GET, from the recorded rows, with a seller breakdown. */
  async function reader(answer?: (kind: "capture" | "refund", id: string) => PayPalResult<CaptureReceipt | RefundReceipt> | undefined) {
    const captures = new Map((await handle.db.select().from(paypalCaptures)).map((row) => [row.paypalCaptureId, row.amountCents]));
    const refunds = new Map((await handle.db.select().from(paypalRefunds)).map((row) => [row.paypalRefundId, row.amountCents]));
    const reads: string[] = [];
    const ok = <T>(value: T): PayPalResult<T> => ({ kind: "ok", value, trace: { httpStatus: 200, debugId: "debug-fee" } });
    return {
      reads,
      getCapture: async (id: string) => {
        reads.push(`capture:${id}`);
        return (answer?.("capture", id) ?? ok({ paypalCaptureId: id, status: "PARTIALLY_REFUNDED", ...usd(captures.get(id)!), settlement: breakdown(captures.get(id)!, captureFee(captures.get(id)!)) })) as PayPalResult<CaptureReceipt>;
      },
      getRefund: async (id: string) => {
        reads.push(`refund:${id}`);
        return (answer?.("refund", id) ?? ok({ paypalRefundId: id, status: "COMPLETED", ...usd(refunds.get(id)!), settlement: breakdown(refunds.get(id)!, 0) })) as PayPalResult<RefundReceipt>;
      },
    };
  }
  const chair = async () => (await paymentsWorkspace(handle.db, session, v4.id))!.lines.find((entry) => entry.itemId === CHAIR)!;
  const paymentRows = async () => ({
    operations: (await handle.db.select().from(paymentOperations)).map(({ id, status, updatedAt }) => ({ id, status, updatedAt })),
    captures: await handle.db.select().from(paypalCaptures),
    refunds: await handle.db.select().from(paypalRefunds),
  });

  it("reads each completed capture and refund once with GET, shows merchant net, and changes no payment record", async () => {
    const before = await paymentRows();
    const earlier = new Set((await handle.db.select({ id: paypalCalls.id }).from(paypalCalls)).map((row) => row.id));
    const paypalReader = await reader();
    await refreshRecordedFees(handle.db, paypalReader, session, v4.id);
    expect(paypalReader.reads.sort()).toEqual([...before.captures.map((row) => `capture:${row.paypalCaptureId}`), ...before.refunds.map((row) => `refund:${row.paypalRefundId}`)].sort());
    const added = (await handle.db.select().from(paypalCalls)).filter((row) => !earlier.has(row.id));
    expect(added.map((row) => row.step).sort()).toEqual(["get_capture", "get_capture", "get_refund", "get_refund"]);
    expect(added.every((row) => row.details.settlementRead === true && row.outcome === "ok")).toBe(true);
    expect(await paymentRows()).toEqual(before);
    const line = await chair();
    expect([...line.captures, ...line.refunds].map((entry) => (entry as { settlement?: { state: string } }).settlement?.state)).toEqual(["reported", "reported", "reported", "reported"]);
    const grossCaptured = before.captures.reduce((sum, row) => sum + row.amountCents, 0);
    const fees = before.captures.reduce((sum, row) => sum + captureFee(row.amountCents), 0);
    const refunded = before.refunds.reduce((sum, row) => sum + row.amountCents, 0);
    expect(summarizePaymentFees([line])).toMatchObject({ captureFeeCents: fees, refundFeeCents: 0, merchantNetCents: grossCaptured - fees - refunded });
  });

  it("keeps the last answered fees when a later lookup times out", async () => {
    await refreshRecordedFees(handle.db, await reader(), session, v4.id);
    await refreshRecordedFees(handle.db, await reader(() => ({ kind: "unknown", message: "Timed out waiting for PayPal" })), session, v4.id);
    const capture = (await chair()).captures[0] as { settlement?: { state: string; reason: string | null } };
    expect(capture.settlement).toMatchObject({ state: "reported", reason: expect.stringMatching(/did not succeed; these are the last answered amounts/) });
  });

  it("does not adopt fees from an answer that disagrees with the recorded transaction", async () => {
    const before = await paymentRows();
    await refreshRecordedFees(handle.db, await reader((kind, id) => kind === "capture"
      ? { kind: "ok", value: { paypalCaptureId: id, status: "COMPLETED", ...usd(1), settlement: breakdown(1, 0) } } : undefined), session, v4.id);
    const line = await chair();
    expect(line.captures.map((entry) => (entry as { settlement?: { state: string } }).settlement?.state)).toEqual(["invalid", "invalid"]);
    expect(summarizePaymentFees([line]).merchantNetCents).toBeNull();
    expect(await paymentRows()).toEqual(before);
  });

  it("refuses a browser that does not own the case before reading PayPal", async () => {
    const paypalReader = await reader();
    await expect(refreshRecordedFees(handle.db, paypalReader, randomUUID(), v4.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(paypalReader.reads).toHaveLength(0);
  });
});
