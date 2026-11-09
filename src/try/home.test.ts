import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountOrDefault } from "../accounts/demo";
import type { AiOutput } from "../ai/output";
import { currentCaseQuote } from "../approval/baseline";
import { createApprovalStore, readLedger } from "../approval/store";
import { runCaseAi } from "../chat/service";
import { createChatStore } from "../chat/store";
import { chatMessages } from "../chat/schema";
import { changeOrders, paymentOperations } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { HOME_PRODUCT_IDS } from "../demo/home-evidence";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_LEGACY_SCENARIO as HOME_SCENARIO, HOME_SUPPLIER_NOTES } from "../demo/living-dining";
import { readOpening } from "../opening/read";
import { clientSignatureName } from "../opening/types";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { links } from "../payments/testing/flows";
import { paymentsWorkspace } from "../payments/workspace";
import { createPricingInput, previewPricing } from "../pricing/calculation";
import { pricingCases } from "../pricing/schema";
import { createPricingStore } from "../pricing/store";
import { quoteFingerprint } from "../quotes/fingerprint";
import { appendHomeDiscussion } from "./home";
import { trySeeds } from "./schema";
import { MAPLE_SCENARIO, prepareTry, readTryRuns, startTry, type TryDeps, type TrySeed } from "./service";

describe.skipIf(!testDatabaseUrl)("living-and-dining durable scenario", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "projects", "chat_cases", "try_seeds"); paypal = new FakePayPal(); });
  afterAll(() => handle?.pool.end());
  const deps = (): TryDeps => ({ db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) });
  async function start(scenario: typeof HOME_SCENARIO | typeof MAPLE_SCENARIO = HOME_SCENARIO) {
    const result = await startTry(deps(), null, { scenario });
    if (result.kind === "limited") throw new Error("Expected scenario run");
    return result;
  }
  async function step(session: string) {
    const result = await prepareTry(deps(), session, session);
    if (result.kind === "not_found") throw new Error("Expected scenario run");
    return result;
  }
  async function finish(session: string): Promise<TrySeed> {
    for (let index = 0; index < 12; index++) {
      const result = await step(session);
      if (result.kind === "ready") return result.seed;
      if (result.kind === "failed") throw new Error(result.seed.error ?? "Scenario preparation failed");
    }
    throw new Error("Scenario preparation did not finish");
  }

  it("persists six-line prices per case, holds five items and captures only the confirmed sideboard", async () => {
    const run = await start();
    expect(run.seed).toMatchObject({ scenario: HOME_SCENARIO, scenarioVersion: 2 });
    expect(run.seed.stages).toHaveLength(10);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect(paypal.calls).toHaveLength(0);
    const ready = await finish(run.session);
    const [bridge] = await handle.db.select().from(pricingCases);
    expect(bridge.baselineQuote).toEqual(HOME_APPROVED_QUOTE);
    const [saved] = await handle.db.select().from(changeOrders);
    expect(saved.id).toBe(ready.changeOrderId);
    expect(saved.document).toMatchObject({ version: 2, totals: { totalCents: 773_000 } });
    expect(saved.document.lines).toHaveLength(6);
    expect(saved.document.lines.find((line) => line.itemId === "design")).toMatchObject({ origin: "unchanged", unitPriceCents: 100_000 });
    const quote = await currentCaseQuote(handle.db, bridge.caseId, "maple");
    expect(quote?.room).toBe(HOME_APPROVED_QUOTE.room);
    expect(quote?.lines.map((line) => line.itemId)).toEqual(saved.document.lines.map((line) => line.itemId));
    for (const line of quote!.lines) {
      const original = HOME_APPROVED_QUOTE.lines.find((entry) => entry.itemId === line.itemId)!;
      expect(line).toMatchObject({ sku: original.sku, specification: original.specification, quantity: original.quantity, unitPriceCents: original.unitPriceCents });
      expect(line.sku).not.toContain("-PREPARED");
      if (line.category === "furniture") expect(line.returnPolicy).toContain(original.returnPolicy);
    }
    const opening = await readOpening(handle.db, { id: bridge.caseId, projectKey: "maple" });
    expect(opening.document.lines).toHaveLength(6);
    expect(opening.opening.totalCents).toBe(773_000);
    const ledger = await readLedger(handle.db, bridge.projectId);
    expect(ledger.authorizations.map((hold) => hold.amountCents).sort((a, b) => a - b)).toEqual([65_000, 108_000, 120_000, 140_000, 240_000]);
    expect(ledger.captures).toHaveLength(1);
    expect(ledger.captures[0]).toMatchObject({ amountCents: 120_000, status: "completed" });
    expect(ledger.operations.filter((operation) => operation.kind === "authorize")).toHaveLength(5);
    const chat = await createChatStore(handle.db).getCase(run.session, "maple");
    expect(chat.draft).toBeNull();
    expect(chat.activeMessageId).toBeNull();
    expect(chat.messages.filter((message) => message.model === "demo-scenario-discussion").map(({ actor, text }) => ({ actor, text }))).toEqual(HOME_DISCUSSION);
    expect(chat.messages.filter((message) => message.model === "demo-supplier-notes")).toEqual([expect.objectContaining({ actor: "designer", text: HOME_SUPPLIER_NOTES })]);
    expect(chat.messages.filter((message) => message.model === "demo-scenario-discussion").every((message) => !message.text.startsWith("@Setti"))).toBe(true);
    const calls = paypal.calls.length;
    await appendHomeDiscussion(handle.db, run.session, saved.document);
    expect((await createChatStore(handle.db).getCase(run.session, "maple")).messages).toHaveLength(chat.messages.length);
    expect((await step(run.session)).kind).toBe("ready");
    expect(paypal.calls).toHaveLength(calls);
    await expect(handle.db.update(pricingCases).set({ baselineQuote: { ...HOME_APPROVED_QUOTE, room: "Changed" } }).where(eq(pricingCases.caseId, bridge.caseId))).rejects.toThrow();
  });

  it("keeps new and legacy scenarios isolated when the browser explicitly selects a different one", async () => {
    const legacy = await start(MAPLE_SCENARIO);
    await step(legacy.session);
    const newer = await startTry(deps(), legacy.session, { visitorId: legacy.visitorId, scenario: HOME_SCENARIO });
    if (newer.kind === "limited") throw new Error("Expected a separate scenario");
    expect(newer.session).not.toBe(legacy.session);
    expect(newer.seed.scenario).toBe(HOME_SCENARIO);
    await step(newer.session);
    const legacyChat = await createChatStore(handle.db).getCase(legacy.session, "maple");
    const newChat = await createChatStore(handle.db).getCase(newer.session, "maple");
    expect(legacyChat.quote?.lines.map((line) => line.itemId)).toEqual(["design", "chair", "rug"]);
    expect(newChat.quote?.lines).toHaveLength(6);
    expect((await handle.db.select().from(pricingCases)).filter((bridge) => bridge.baselineQuote === null)).toHaveLength(1);
    expect(await readTryRuns(handle.db, legacy.visitorId, newer.session)).toEqual([expect.objectContaining({ runId: legacy.session })]);
    expect(await startTry(deps(), newer.session)).toMatchObject({ session: newer.session, reused: true, seed: { scenario: HOME_SCENARIO } });
    expect(paypal.calls).toHaveLength(0);
  });

  it("carries the five-item AI proposal through review and V3 approval without conflating its separate payment paths", async () => {
    const run = await start(), ready = await finish(run.session);
    const chat = createChatStore(handle.db), pricing = createPricingStore(handle.db);
    const prepared = await chat.getCase(run.session, "maple");
    const quote = prepared.quote!;
    expect(quote).toMatchObject({ id: ready.changeOrderId, version: 2 });
    const discussion = prepared.messages.filter((message) => message.model === "demo-scenario-discussion");
    const requestId = randomUUID();
    await chat.appendMessage(run.session, "maple", { id: requestId, actor: "designer", text: HOME_DESIGNER_REQUEST });
    const output: AiOutput = {
      intent: "draft", message: "A proposal for Jordan to review.", title: "Living and dining revision",
      changes: [
        { action: "replace", itemId: "sofa", quantity: 1, productOptionId: HOME_PRODUCT_IDS.sofa, description: "Compact sofa", sourceMessageIds: [discussion[4].id] },
        { action: "replace", itemId: "coffee-table", quantity: 2, productOptionId: HOME_PRODUCT_IDS["coffee-table"], description: "Two side tables", sourceMessageIds: [discussion[6].id] },
        { action: "replace", itemId: "dining-table", quantity: 1, productOptionId: HOME_PRODUCT_IDS["dining-table"], description: "Round table", sourceMessageIds: [discussion[10].id] },
        { action: "quantity", itemId: "dining-chairs", quantity: 4, productOptionId: null, description: "", sourceMessageIds: [discussion[12].id] },
        { action: "remove", itemId: "sideboard", quantity: null, productOptionId: null, description: "", sourceMessageIds: [discussion[12].id] },
      ], unresolved: [], constraints: ["Keep the design-service scope unchanged."],
    };
    const providerCalls = paypal.calls.length;
    const proposed = await runCaseAi(chat, run.session, "maple", requestId, {
      configured: () => true,
      callModel: async (context) => {
        expect(context.quote?.id).toBe(ready.changeOrderId);
        expect(context.messages.filter((message) => message.model === "demo-scenario-discussion")).toHaveLength(HOME_DISCUSSION.length);
        expect(context.pages.flatMap((page) => page.products.map((product) => product.id))).toEqual(Object.values(HOME_PRODUCT_IDS));
        return { output, model: "stub-living-dining-model" };
      },
    });
    const draft = proposed.draft!, input = createPricingInput(quote, draft);
    expect(draft.origin).toBe("designer");
    expect(previewPricing(quote, draft, input)).toMatchObject({ ready: false, proposedTotals: { totalCents: 567_000 }, deltaTotalCents: -206_000 });
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues.forEach((issue) => { issue.resolved = true; });
    input.reviewNotes = "Test review: checked all five source products, old-item handling and the unchanged service fee.";
    const workspace = await pricing.getWorkspace(run.session, "maple");
    const saved = await pricing.saveReview(run.session, "maple", {
      sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: workspace.review?.version ?? null, input,
    });
    const { order } = await pricing.issueReview(run.session, "maple", { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    expect(order).toMatchObject({ version: 3, totals: { totalCents: 567_000 }, deltaTotalCents: -206_000, source: { kind: "client" } });
    expect((await paymentsWorkspace(handle.db, run.session, order.id))?.plan).toBeNull();
    await createApprovalStore(handle.db).decide(run.session, order.id, {
      decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash,
      acknowledged: true, signature: clientSignatureName(order), note: "Reviewed the complete revised proposal in this test.",
    });
    const payments = (await paymentsWorkspace(handle.db, run.session, order.id, new Date(), accountOrDefault("jordan")))!;
    const plan = payments.plan!;
    expect(payments.current).toBe(true);
    expect(plan.status).toBe("preview");
    expect(plan.blockers).toEqual([]);
    for (const [itemId, heldCents, newCents] of [["sofa", 240_000, 210_000], ["coffee-table", 65_000, 36_000], ["dining-table", 140_000, 125_000]] as const) {
      const old = payments.lines.find((line) => line.itemId === itemId && line.side === "baseline")!;
      const replacement = payments.lines.find((line) => line.itemId === itemId && line.side === "proposed")!;
      expect(old).toMatchObject({ heldCents, capturedCents: 0, targetCents: 0 });
      expect(replacement).toMatchObject({ heldCents: 0, capturedCents: 0, targetCents: newCents });
      expect(replacement.businessItemId).not.toBe(old.businessItemId);
      expect(plan.actions).toContainEqual(expect.objectContaining({ itemId, side: "baseline", kind: "release_authorization", amountCents: heldCents, timing: "on_payment_execution" }));
      expect(plan.actions).toContainEqual(expect.objectContaining({ itemId, side: "proposed", kind: "new_authorization", amountCents: newCents }));
    }
    const chairs = payments.lines.find((line) => line.itemId === "dining-chairs")!;
    expect(chairs).toMatchObject({ side: "baseline", heldCents: 108_000, capturedCents: 0, targetCents: 72_000 });
    expect(plan.actions).toContainEqual(expect.objectContaining({ itemId: "dining-chairs", kind: "capture", amountCents: 72_000, timing: "after_vendor_confirmation" }));
    expect(plan.actions).toContainEqual(expect.objectContaining({ itemId: "dining-chairs", kind: "release_authorization", amountCents: 36_000, timing: "after_vendor_confirmation" }));
    expect(chairs.steps).toContainEqual(expect.objectContaining({ kind: "supplier_confirmation", available: true, amountCents: 72_000 }));
    expect(chairs.steps).toContainEqual(expect.objectContaining({ kind: "capture", available: false, amountCents: 72_000 }));
    const sideboard = payments.lines.find((line) => line.itemId === "sideboard")!;
    expect(sideboard).toMatchObject({ capturedCents: 120_000, refundedCents: 0, targetCents: 24_000, refundRequiresSupplierCredit: true });
    expect(plan.actions).toContainEqual(expect.objectContaining({ itemId: "sideboard", kind: "refund", amountCents: 96_000, timing: "after_vendor_credit" }));
    expect(sideboard.steps).toContainEqual(expect.objectContaining({ kind: "supplier_credit", available: true, amountCents: 96_000 }));
    expect(sideboard.steps).toContainEqual(expect.objectContaining({ kind: "refund", available: false, amountCents: 96_000 }));
    expect(plan.lines.find((line) => line.itemId === "design")).toMatchObject({ changed: false, targetCents: 100_000, heldCents: 0, capturedCents: 0, refundedCents: 0 });
    expect(plan.actions).toContainEqual(expect.objectContaining({ itemId: "design", kind: "capture", amountCents: 100_000, timing: "on_payment_execution" }));
    expect(payments.others).toEqual({ lineCount: 1, targetCents: 100_000 });
    expect(paypal.calls).toHaveLength(providerCalls);
    expect(payments.operations).toHaveLength(6);
  });

  it("recovers lost answers and stale stages against their original item operations and never repeats the discussion", async () => {
    const run = await start();
    await step(run.session);
    paypal.then("lose-response");
    expect((await step(run.session)).kind).toBe("failed");
    const [original] = await handle.db.select().from(paymentOperations);
    await finish(run.session);
    const calls = paypal.calls.length;
    const [row] = await handle.db.select().from(trySeeds).where(eq(trySeeds.sessionId, run.session));
    await handle.db.update(trySeeds).set({ status: "seeding", stages: row.stages.map((stage) => stage.id === "sofa_hold" || stage.id === "discussion" ? { ...stage, status: "running" as const } : stage), leaseId: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(trySeeds.sessionId, run.session));
    const before = await handle.db.select().from(chatMessages);
    await finish(run.session);
    expect(paypal.calls).toHaveLength(calls);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(6);
    expect((await handle.db.select().from(paymentOperations)).some((operation) => operation.id === original.id)).toBe(true);
    expect(await handle.db.select().from(chatMessages)).toHaveLength(before.length);
    const [bridge] = await handle.db.select().from(pricingCases);
    expect(quoteFingerprint(bridge.baselineQuote!)).toBe(quoteFingerprint(HOME_APPROVED_QUOTE));
  });

  it("starts the new story separately from an older workspace without a try seed", async () => {
    const oldSession = randomUUID(), chat = createChatStore(handle.db);
    expect((await chat.getCase(oldSession, "maple")).quote?.lines.map((line) => line.itemId)).toEqual(["design", "chair", "rug"]);
    const run = await startTry(deps(), oldSession, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a separate scenario");
    expect(run.session).not.toBe(oldSession);
    await step(run.session);
    expect((await chat.getCase(run.session, "maple")).quote?.lines).toHaveLength(6);
    expect((await chat.getCase(oldSession, "maple")).quote?.lines.map((line) => line.itemId)).toEqual(["design", "chair", "rug"]);
    expect(paypal.calls).toHaveLength(0);
  });

  it("does not switch an actively leased old run or prepare an unsupported persisted scenario", async () => {
    const legacy = await start(MAPLE_SCENARIO);
    await handle.db.update(trySeeds).set({ leaseId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(trySeeds.sessionId, legacy.session));
    expect(await startTry(deps(), legacy.session, { scenario: HOME_SCENARIO })).toMatchObject({ session: legacy.session, reused: true, seed: { scenario: MAPLE_SCENARIO } });
    await handle.db.update(trySeeds).set({ scenario: "future-scenario", leaseId: null, leaseExpiresAt: null }).where(eq(trySeeds.sessionId, legacy.session));
    expect(await step(legacy.session)).toMatchObject({ kind: "failed", seed: { canResume: false } });
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect(paypal.calls).toHaveLength(0);
  });
});
