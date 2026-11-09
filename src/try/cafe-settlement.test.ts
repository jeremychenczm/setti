/**
 * The whole café walkthrough after the AI draft: one signature on V2, then every line's own PayPal
 * steps until each line is settled and the money adds up to the signed V2 total.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountOrDefault } from "../accounts/demo";
import type { AiOutput } from "../ai/output";
import { createApprovalStore, readLedger } from "../approval/store";
import { runCaseAi } from "../chat/service";
import { createChatStore } from "../chat/store";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { HOME_PRODUCT_IDS } from "../demo/home-evidence";
import { HOME_DESIGNER_REQUEST, HOME_SCENARIO } from "../demo/living-dining";
import { clientSignatureName } from "../opening/types";
import { startCapture, startRefund } from "../payments/actions";
import { attentionView } from "../payments/attention-view";
import { inboxView } from "../payments/inbox-view";
import { checkServicesCheckout, startServicesCheckout } from "../payments/services";
import { recordSupplierCredit, recordSupplierOrder } from "../payments/supplier";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import type { PaymentLineView } from "../payments/types";
import { afterVersionConfirmed } from "../payments/version-confirmed";
import { paymentsWorkspace } from "../payments/workspace";
import { createPricingInput } from "../pricing/calculation";
import { pricingCases } from "../pricing/schema";
import { createPricingStore } from "../pricing/store";
import { readVersionReceipt } from "../receipts/record";
import { lineProgress } from "../ui/payments/progress";
import { mapleGuideStep } from "../ui/try/maple-guide";
import { prepareTry, startTry, type TryDeps } from "./service";

describe.skipIf(!testDatabaseUrl)("café walkthrough after one signature", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>, paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "projects", "chat_cases", "try_seeds"); paypal = new FakePayPal(); });
  afterAll(() => handle?.pool.end());
  const deps = (): TryDeps => ({ db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) });

  /** V1 prepared with its starting payments, then the seven-change V2 drafted, priced, sent and signed. */
  async function signedV2() {
    const run = await startTry(deps(), null, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a local project");
    for (let index = 0; index < 20; index++) {
      const step = await prepareTry(deps(), run.session, run.session);
      if (step.kind === "ready") break;
      if (step.kind === "failed" || step.kind === "not_found") throw new Error("V1 preparation failed");
    }
    const chat = createChatStore(handle.db), pricing = createPricingStore(handle.db), requestId = randomUUID();
    const discussion = (await chat.getCase(run.session, "maple")).messages.filter((message) => message.model === "demo-scenario-discussion");
    await chat.appendMessage(run.session, "maple", { id: requestId, actor: "designer", text: HOME_DESIGNER_REQUEST });
    const source = (index: number) => [discussion[index].id];
    const output: AiOutput = { intent: "draft", message: "Draft for review", title: "Window bay and back bar revision", unresolved: [], constraints: [], changes: [
      { action: "add", itemId: null, quantity: 16, productOptionId: HOME_PRODUCT_IDS.windowCounter, description: "", sourceMessageIds: source(1) },
      { action: "quantity", itemId: "stools", quantity: 14, productOptionId: null, description: "", sourceMessageIds: source(2) },
      { action: "add", itemId: null, quantity: 12, productOptionId: HOME_PRODUCT_IDS.panels, description: "", sourceMessageIds: source(5) },
      { action: "quantity", itemId: "countertop", quantity: 18, productOptionId: null, description: "", sourceMessageIds: source(7) },
      { action: "quantity", itemId: "pendants", quantity: 4, productOptionId: null, description: "", sourceMessageIds: source(9) },
      { action: "replace", itemId: "wall-tile", quantity: 20, productOptionId: HOME_PRODUCT_IDS["wall-tile"], description: "", sourceMessageIds: source(13) },
      { action: "quantity", itemId: "site-visits", quantity: 6, productOptionId: null, description: "", sourceMessageIds: source(16) },
    ] };
    const state = await runCaseAi(chat, run.session, "maple", requestId, { configured: () => true, callModel: async () => ({ output, model: "stub-external-model" }) });
    const input = createPricingInput(state.quote!, state.draft!);
    input.changes.forEach((change) => { change.confirmed = true; });
    input.reviewNotes = "Checked against the supplier documents.";
    const saved = await pricing.saveReview(run.session, "maple", { sourceDraftId: state.draft!.id, sourceDraftRevision: state.draft!.revision, expectedVersion: null, input });
    const { order } = await pricing.issueReview(run.session, "maple", { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    await createApprovalStore(handle.db).decide(run.session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: "Looks right." });
    return { session: run.session, order };
  }

  it("holds, takes the client's site-visit payment, records each supplier step, captures and refunds until every line is settled", async () => {
    const { session, order } = await signedV2();
    const shown = { contentHash: order.contentHash, revisionContentHash: order.revisionContentHash };
    const workspace = async () => (await paymentsWorkspace(handle.db, session, order.id, new Date(), accountOrDefault("jordan")))!;
    const ref = (line: PaymentLineView) => ({ itemId: line.itemId, side: line.side, ...shown });
    const find = (lines: PaymentLineView[], itemId: string, side: "baseline" | "proposed") => lines.find((line) => line.itemId === itemId && line.side === side)!;

    // Confirming V2: Setti holds the new amounts on Emma's saved card. No hold needs releasing yet.
    const holds = await afterVersionConfirmed(handle.db, paypal, session, "maple", order.id, links);
    expect(holds.map((operation) => [operation.status, operation.amountCents]).sort((a, b) => Number(a[1]) - Number(b[1])))
      .toEqual([["succeeded", 117_000], ["succeeded", 152_000], ["succeeded", 174_000], ["succeeded", 336_000]]);

    // The walkthrough's guide, inbox, reminders and receipts read this session's café V1, not the built-in Maple quote.
    const snapshot = await createChatStore(handle.db).getCase(session, "maple");
    const confirmed = await workspace();
    const guide = (days: number) => mapleGuideStep({ seedOrderId: null, scenario: HOME_SCENARIO, snapshot: { ...snapshot, aiConfigured: true }, pricing: null, payments: confirmed, simulatedDays: days }, "designer");
    expect(guide(0).detail).toMatch(/^Setti placed 4 new holds on Emma's saved card, but no supplier order is recorded for the 5 held items\. /);
    expect(guide(3).title).toBe("Setti caught it: 5 held items are still not ordered");
    expect((await inboxView(handle.db, null, session, accountOrDefault("emma"))).project).toEqual({ key: "maple", name: "Maple Ave Café" });
    const reminders = (await attentionView(handle.db, session, accountOrDefault("jordan"), new Date(Date.now() + 4 * 86_400_000))).items.filter((item) => item.projectKey === "maple");
    expect(reminders.length).toBeGreaterThan(0);
    expect(new Set(reminders.map((item) => item.projectName))).toEqual(new Set(["Maple Ave Café"]));
    for (const version of [1, 2]) expect((await readVersionReceipt(handle.db, session, "maple", version)).project).toMatchObject({ name: "Maple Ave Café", room: "Front of house" });
    // The signed V2 states what the old countertop and tile keep from Emma, by type.
    const signed = (await readVersionReceipt(handle.db, session, "maple", 2)).agreement;
    const oldItems = signed.kind === "change" ? new Map(signed.changes.map((change) => [change.itemId, change.oldItem])) : new Map();
    expect(oldItems.get("countertop")).toMatchObject({ handling: "modified", retainedCents: 28_000, fees: [{ kind: "fabrication_fee", amountCents: 28_000 }] });
    expect(oldItems.get("wall-tile")).toMatchObject({ handling: "returned", retainedCents: 19_600, fees: [{ kind: "restocking_fee", amountCents: 19_600 }] });

    // The money answer's item table comes from the records, in fixed words: before any supplier step, what is held and what waits.
    const money = async () => new Map((await createChatStore(handle.db).readMoneyContext!(session, "maple")).items!.map((item) => [item.key, item]));
    const early = await money();
    expect(early.get("baseline:countertop")).toMatchObject({ status: "waiting_for_supplier_credit", chargedCents: 396_000, nonRefundableCents: 28_000 });
    expect([...early.values()].filter((item) => item.status === "on_hold").map((item) => item.label).sort()).toEqual(["Acoustic ceiling panel (new)", "Back bar wall tile, sage green (new)", "Counter pendant light", "Counter stool", "Oak window counter (new)"]);

    // Emma pays for the two extra site visits; the design fee was paid with V1.
    const checkout = await startServicesCheckout(handle.db, paypal, session, "maple", links);
    expect(checkout.amountCents).toBe(36_000);
    paypal.approve(checkout.paypalOrderId!);
    expect((await checkServicesCheckout(handle.db, paypal, session, "maple", checkout.id, links)).state).toBe("authorized");

    // Jordan records each supplier's confirmation on the signed terms, then captures.
    let lines = (await workspace()).lines;
    const supplied: [string, "baseline" | "proposed", number, number, number][] = [
      ["pendants", "baseline", 4, 24_000, 21], ["stools", "baseline", 14, 19_500, 21], ["wall-tile", "proposed", 20, 7_600, 10],
    ];
    const added = lines.filter((line) => line.side === "proposed" && line.itemId.startsWith("new-"));
    expect(added.map((line) => line.targetCents).sort((a, b) => a - b)).toEqual([174_000, 336_000]);
    for (const line of added) supplied.push([line.itemId, "proposed", line.targetCents === 336_000 ? 16 : 12, line.targetCents === 336_000 ? 21_000 : 14_500, line.targetCents === 336_000 ? 21 : 14]);
    for (const [itemId, side, quantity, unitPriceCents, leadTimeDays] of supplied) {
      const line = find(lines, itemId, side);
      await recordSupplierOrder(handle.db, session, order.id, { ...ref(line), quantity, unitPriceCents, taxCents: 0, freightCents: 0, inStock: true, leadTimeDays, reference: `DEMO-ORDER-${itemId}`, note: "Demo supplier confirmation." });
      const captured = await startCapture(handle.db, paypal, session, order.id, ref(line));
      expect(captured.every((operation) => operation.status === "succeeded")).toBe(true);
    }

    // The fabricator credits the cut-off length less its re-cut fee; the tile supplier credits the returned boxes less 20%.
    lines = (await workspace()).lines;
    for (const [itemId, creditCents] of [["countertop", 44_000], ["wall-tile", 78_400]] as const) {
      const line = find(lines, itemId, "baseline");
      expect(lineProgress(line).label).toBe("Awaiting supplier credit");
      expect(line.nonRefundable).toEqual({ oldItemCostCents: itemId === "countertop" ? 28_000 : 19_600, oldItemFees: [{ kind: itemId === "countertop" ? "fabrication_fee" : "restocking_fee", amountCents: itemId === "countertop" ? 28_000 : 19_600 }] });
      await recordSupplierCredit(handle.db, session, order.id, { ...ref(line), creditCents, reference: `DEMO-CREDIT-${itemId}`, note: "Demo supplier credit." });
      const refunded = await startRefund(handle.db, paypal, session, order.id, ref(line));
      expect(refunded.map((operation) => [operation.status, operation.amountCents])).toEqual([["succeeded", creditCents]]);
    }

    // Every changed line is settled, and nothing is still held.
    const final = await workspace();
    const open = final.lines.filter((line) => line.changed && !lineProgress(line, final.operations).settled);
    expect(open.map((line) => [line.itemId, line.side, lineProgress(line, final.operations).label])).toEqual([]);
    expect(final.lines.reduce((sum, line) => sum + line.heldCents, 0)).toBe(0);
    expect(final.lines.find((line) => line.itemId === "pendants")).toMatchObject({ capturedCents: 96_000, releasedCents: 48_000 });

    // What PayPal actually kept adds up to the signed V2 total.
    const [bridge] = await handle.db.select().from(pricingCases);
    const ledger = await readLedger(handle.db, bridge.projectId);
    const captured = ledger.captures.filter((capture) => capture.status === "completed").reduce((sum, capture) => sum + capture.amountCents, 0);
    const refunded = ledger.refunds.filter((refund) => refund.status === "completed").reduce((sum, refund) => sum + refund.amountCents, 0);
    expect([captured, refunded, captured - refunded]).toEqual([1_873_000, 122_400, 1_750_600]);
    expect(order.totals.totalCents).toBe(1_750_600);

    // Settled: each item's status and amounts as the answer's table shows them.
    const settled = await money();
    expect(settled.get("baseline:countertop")).toMatchObject({ label: "Quartz countertop", status: "refunded", chargedCents: 396_000, refundedCents: 44_000, nonRefundableCents: 28_000, nonRefundableFees: [{ kind: "fabrication_fee", amountCents: 28_000 }], netCents: 352_000 });
    expect(settled.get("baseline:wall-tile")).toMatchObject({ label: "Back bar wall tile (original)", status: "refunded", nonRefundableCents: 19_600, netCents: 19_600 });
    expect(settled.get("proposed:wall-tile")).toMatchObject({ label: "Back bar wall tile, sage green (new)", status: "charged", netCents: 152_000 });
    expect(settled.get("baseline:pendants")).toMatchObject({ status: "charged", releasedCents: 48_000, nonRefundableFees: [], netCents: 96_000 });
    expect([...settled.values()].reduce((sum, item) => sum + item.netCents, 0)).toBe(1_750_600);
    expect([...settled.values()].every((item) => item.factIds.includes(`item:${item.key}`))).toBe(true);
  });
});
