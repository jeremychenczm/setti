import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../approval/store";
import { createChatStore } from "../chat/store";
import { chatCases, chatMessages } from "../chat/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { paypalCalls } from "../payments/schema";
import { returnFromPayPal, startAuthorization, startCapture, startRefund, startRelease } from "../payments/actions";
import { recordSupplierCredit, recordSupplierOrder } from "../payments/supplier";
import { signOpeningForTest } from "../opening/testing";
import { confirmChanges, shown } from "../payments/testing/cases";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { pricingCases } from "../pricing/schema";
import { addTestProject, TEST_KEY } from "../projects/testing";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";
import { readCaseMoneyContext } from "./money-context";
import type { MoneyContext } from "./money-types";
import { HOME_SCENARIO } from "../demo/living-dining";
import { prepareTry, startTry, type TryDeps } from "../try/service";

function product(name: string, sku: string, unitPriceCents: number): Partial<PricingItem> {
  return { name, vendor: "Demo supplier", sku, specification: name, quantity: 1, unitLabel: "each", currency: "USD", unitPriceCents, taxCents: 0, freightCents: 0, returnable: true, returnPolicy: "Demo terms checked by the designer." };
}

describe.skipIf(!testDatabaseUrl)("read-only case money evidence", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases", "try_seeds");
    session = randomUUID();
    paypal = new FakePayPal();
  });
  afterAll(() => handle?.pool.end());

  const text = (context: MoneyContext, id: string) => context.facts.find((entry) => entry.id === id)!.text.en;
  const ref = (order: FrozenChangeOrder, itemId: string, side: "baseline" | "proposed" = "proposed") => ({ itemId, side, ...shown(order) });
  const read = () => readCaseMoneyContext(handle.db, session, "maple");
  const supplier = (order: FrozenChangeOrder, itemId: string) => {
    const item = order.lines.find((line) => line.itemId === itemId)!;
    return recordSupplierOrder(handle.db, session, order.id, { ...ref(order, itemId), quantity: item.quantity, unitPriceCents: item.unitPriceCents, taxCents: item.taxCents, freightCents: item.freightCents, inStock: true, leadTimeDays: 14, reference: `DEMO-${itemId}`, note: "Entered by designer in this demo." });
  };
  async function authorize(order: FrozenChangeOrder, itemId: string) {
    const checkout = await startAuthorization(handle.db, paypal, session, order.id, ref(order, itemId), links);
    paypal.approve(checkout.paypalOrderId!);
    expect(await returnFromPayPal(handle.db, paypal, checkout.id, checkout.paypalOrderId, "return")).toMatchObject({ state: "authorized" });
  }
  async function mixedCase() {
    const initial = await confirmChanges(handle.db, session, "maple", [
      { action: "replace", itemId: "chair", after: product("Confirmed lounge chair", "CHAIR-2", 80_000) },
      { action: "replace", itemId: "rug", after: product("Confirmed wool rug", "RUG-2", 30_000) },
    ]);
    await authorize(initial, "chair");
    await authorize(initial, "rug");
    await supplier(initial, "rug");
    await startCapture(handle.db, paypal, session, initial.id, ref(initial, "rug"));
    return confirmChanges(handle.db, session, "maple", [
      { action: "replace", itemId: "chair", after: product("Oak writing desk", "DESK-1", 110_000), oldItemHandling: "not_ordered", oldItemCostCents: 0 },
      { action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000 },
    ]);
  }
  async function deskPaid(order: FrozenChangeOrder) {
    await startRelease(handle.db, paypal, session, order.id, ref(order, "chair", "baseline"));
    await authorize(order, "chair");
    await supplier(order, "chair");
    await startCapture(handle.db, paypal, session, order.id, ref(order, "chair"));
  }
  function credit(order: FrozenChangeOrder) {
    return recordSupplierCredit(handle.db, session, order.id, { ...ref(order, "rug", "baseline"), creditCents: 24_000, reference: "DEMO-RUG-CREDIT", note: "Demo credit, net of retained fee." });
  }
  async function storedState() {
    const [bridge] = await handle.db.select().from(pricingCases);
    return {
      cases: await handle.db.select().from(chatCases),
      messages: await handle.db.select().from(chatMessages),
      calls: await handle.db.select().from(paypalCalls),
      ledger: bridge ? await readLedger(handle.db, bridge.projectId) : null,
    };
  }
  function expectSources(context: MoneyContext) {
    const ids = new Set(context.sources.map((source) => source.id));
    expect(ids.size).toBe(context.sources.length);
    expect(context.facts.every((entry) => entry.sourceIds.length && entry.sourceIds.every((id) => ids.has(id)))).toBe(true);
    expect(context.sources.every((source) => /^\/(?:quotes\/maple|change-orders\/[0-9a-f-]{36}(?:#payment-line-[^\s]+|#payments)?)$/i.test(source.href))).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/approvalUrl|setti-demo-chat|signature|requestId|fake-\d/);
  }

  it("does not create cases or infer real zero balances from an initial quote", async () => {
    await expect(read()).rejects.toMatchObject({ code: "INVALID_MONEY_SCOPE" });
    expect(await handle.db.select().from(chatCases)).toEqual([]);
    await createChatStore(handle.db).getCase(session, "maple");
    const before = await storedState();
    const context = await read();
    expect(context.version).toBe(1);
    expect(context.providerRecordedAt).toBeNull();
    expect(context.mandatoryFactIds).toContain("no-payment-records");
    expect(text(context, "quote")).toContain("$1,500.00");
    expect(text(context, "no-payment-records")).toContain("do not assume they are zero or paid");
    expect(await storedState()).toEqual(before);
    expectSources(context);
  });

  it("reads a real approved V1's original payments and preserves the early-opening preparation state", async () => {
    const deps: TryDeps = { db: handle.db, paypal, links, perHour: 30, testCard: (id) => paypal.confirmWithTestCard(id) };
    const start = await startTry(deps, null, { scenario: HOME_SCENARIO });
    if (start.kind === "limited") throw new Error("Expected a new V1 run");
    session = start.session;
    const beforePreparation = await read();
    expect(beforePreparation).toMatchObject({ version: 1, providerRecordedAt: null });
    expect(beforePreparation.mandatoryFactIds).toContain("payment-preparation");
    expect(text(beforePreparation, "payment-preparation")).toContain("still in progress");
    expect(paypal.calls).toHaveLength(0);
    let seed = start.seed;
    for (let attempt = 0; seed.status !== "ready" && attempt < 20; attempt++) {
      const prepared = await prepareTry(deps, session, session);
      if (prepared.kind === "not_found") throw new Error("Missing prepared V1");
      if (prepared.kind === "failed") throw new Error(prepared.seed.error ?? "Preparation failed");
      seed = prepared.seed;
    }
    expect(seed.status).toBe("ready");
    const beforeRead = await storedState(), providerCalls = paypal.calls.length, providerReads = paypal.reads.length;
    const context = await read();
    expect(context).toMatchObject({ version: 1, quoteId: beforePreparation.quoteId });
    expect(context.mandatoryFactIds).not.toContain("payment-preparation");
    expect(text(context, "item:baseline:stools")).toContain("recorded held amount $1,560.00");
    expect(text(context, "item:baseline:countertop")).toContain("completed captures $3,960.00");
    expect(text(context, "item:baseline:wall-tile")).toContain("completed captures $980.00");
    // Preparation also captures the $2,400 design fee and $720 of site visits alongside the countertop and tile.
    expect(text(context, "scope")).toMatch(/held \$3,000\.00, completed captures \$8,060\.00/);
    expect(text(context, "next:baseline:design")).toContain("recorded net captures cover this agreed V1 target");
    expect(context.providerRecordedAt).not.toBeNull();
    expect(context.sources.some((source) => source.kind === "payment" && source.href === "/quotes/maple#item-holds")).toBe(true);
    expect(context.sources.every((source) => !source.href.startsWith("/change-orders/"))).toBe(true);
    expect([paypal.calls.length, paypal.reads.length]).toEqual([providerCalls, providerReads]);
    expect(await storedState()).toEqual(beforeRead);
  });

  it("only reads the owned case and ignores a newer unapproved proposal", async () => {
    const mixed = await mixedCase();
    const unapproved = await confirmChanges(handle.db, session, "maple", [{ action: "quantity", itemId: "chair", quantity: 2 }], false);
    const context = await read();
    expect(context.quoteId).toBe(mixed.id);
    expect(context.version).toBe(mixed.version);
    expect(context.sources.every((source) => !source.href.includes(unapproved.id))).toBe(true);
    const stranger = randomUUID();
    await expect(readCaseMoneyContext(handle.db, stranger, "maple")).rejects.toMatchObject({ code: "INVALID_MONEY_SCOPE" });
    await createChatStore(handle.db).getCase(stranger, "maple");
    const other = await readCaseMoneyContext(handle.db, stranger, "maple");
    expect(other.quoteId).not.toBe(mixed.id);
    expect(JSON.stringify(other)).not.toContain("Oak writing desk");
    expect(other.sources.every((source) => !source.href.includes(mixed.id))).toBe(true);
    // A V1 sent from the chat has no money evidence until its client signs it.
    await addTestProject(handle.db, session);
    await expect(readCaseMoneyContext(handle.db, session, TEST_KEY)).rejects.toMatchObject({ code: "MONEY_EVIDENCE_UNAVAILABLE" });
    await signOpeningForTest(handle.db, session, TEST_KEY);
    expect((await readCaseMoneyContext(handle.db, session, TEST_KEY)).version).toBe(1);
    expectSources(context);
  });

  it("explains independent mixed-item money, the budget difference, and the unpaid design fee", async () => {
    await mixedCase();
    const context = await read();
    expect(text(context, "budget")).toMatch(/\$1,560\.00.*\$1,500\.00.*\+\$60\.00/);
    expect(text(context, "item:baseline:chair")).toContain("currently held $800.00");
    expect(text(context, "next:proposed:chair")).toContain("short of $1,100.00");
    expect(text(context, "item:proposed:chair")).toContain("This new purchase has its own authorization");
    expect(text(context, "next:proposed:chair")).toContain("another item's released hold does not pay for it");
    expect(text(context, "terms:baseline:rug")).toContain("the non-refundable cost is $60.00: Restocking fee $60.00");
    expect(text(context, "next:baseline:rug")).toContain("$240.00 remains to be refunded after the supplier credit");
    expect(text(context, "outside-scope")).toContain("$400.00");
    expect(context.mandatoryFactIds).toContain("outside-scope");
    expect(context.providerRecordedAt).not.toBeNull();
    expect(text(context, "record-freshness")).toContain("No live PayPal query");
    expectSources(context);
  });

  it("preserves the desk-paid/rug-waiting state and actual transaction references without writes or provider reads", async () => {
    const mixed = await mixedCase();
    await deskPaid(mixed);
    const before = await storedState();
    const calls = paypal.calls.length, reads = paypal.reads.length;
    const context = await read();
    expect(text(context, "item:baseline:chair")).toContain("released authorization $800.00");
    expect(text(context, "item:proposed:chair")).toContain("completed captures $1,100.00");
    expect(text(context, "next:baseline:rug")).toContain("$240.00 remains to be refunded after the supplier credit");
    expect(text(context, "scope")).toContain("net captured $1,400.00");
    expect(context.sources.some((source) => source.kind === "supplier" && source.label.includes("Demo supplier"))).toBe(true);
    expect(context.sources.some((source) => source.kind === "payment" && source.label.includes("PayPal capture"))).toBe(true);
    expect([paypal.calls.length, paypal.reads.length]).toEqual([calls, reads]);
    expect(await storedState()).toEqual(before);
    expectSources(context);
  });

  it("returns completed refund facts from the same version and leaves old snapshots unchanged", async () => {
    const mixed = await mixedCase();
    await deskPaid(mixed);
    const previous = await read();
    await credit(mixed);
    await startRefund(handle.db, paypal, session, mixed.id, ref(mixed, "rug", "baseline"));
    const context = await read();
    expect(text(context, "scope")).toContain("completed refunds $240.00");
    expect(text(context, "scope")).toContain("net captured $1,160.00");
    expect(text(context, "item:baseline:rug")).toContain("net captured $60.00");
    expect(text(context, "next:baseline:rug")).toContain("match the approved target of $60.00");
    expect(context.sources.some((source) => source.label.includes("PayPal refund"))).toBe(true);
    expect(text(previous, "next:baseline:rug")).toContain("after the supplier credit");
    expectSources(context);
  });

  it("keeps unresolved operations and supplier waiting conditions mandatory even while the plan blocks", async () => {
    const mixed = await mixedCase();
    const checkout = await startAuthorization(handle.db, paypal, session, mixed.id, ref(mixed, "chair"), links);
    const context = await read();
    expect(context.mandatoryFactIds).toEqual(expect.arrayContaining(["funding-blockers", `operation:${checkout.id}`]));
    expect(text(context, `operation:${checkout.id}`)).toContain("outcome is pending");
    expect(text(context, "next:baseline:rug")).toContain("after the supplier credit");
    expectSources(context);
  });

  it("does not count a pending refund as completed, even when its operation succeeded", async () => {
    const mixed = await mixedCase();
    await deskPaid(mixed);
    await credit(mixed);
    paypal.then("answer-pending");
    const [operation] = await startRefund(handle.db, paypal, session, mixed.id, ref(mixed, "rug", "baseline"));
    expect(operation.status).toBe("succeeded");
    const context = await read();
    expect(text(context, "scope")).toContain("completed refunds $0.00");
    expect(text(context, "scope")).toContain("net captured $1,400.00");
    expect(context.mandatoryFactIds).toEqual(expect.arrayContaining(["funding-blockers", "next:baseline:rug"]));
    expect(text(context, "next:baseline:rug")).toContain("pending or unknown");
    expectSources(context);
  });
});
