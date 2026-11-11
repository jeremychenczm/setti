import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findAccount } from "../accounts/demo";
import type { AiOutput } from "../ai/output";
import { createApprovalStore, readLedger } from "../approval/store";
import { runCaseAi } from "../chat/service";
import { createChatStore } from "../chat/store";
import { changeOrders, paymentOperations, revisions } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { HOME_PRODUCT_IDS } from "../demo/home-evidence";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_SCENARIO } from "../demo/living-dining";
import { readOpening } from "../opening/read";
import { clientSignatureName } from "../opening/types";
import { FakePayPal } from "../payments/testing/fake-paypal";
import { startAuthorization } from "../payments/actions";
import { completeAuthorization } from "../payments/authorize";
import { servicesPaymentView } from "../payments/services-view";
import { links } from "../payments/testing/flows";
import { paymentsWorkspace } from "../payments/workspace";
import { createPricingInput, previewPricing } from "../pricing/calculation";
import { pricingCases } from "../pricing/schema";
import { createPricingStore } from "../pricing/store";
import { trySeeds } from "./schema";
import { prepareTry, startTry, type TryDeps } from "./service";
import { findProject } from "../projects/store";

describe.skipIf(!testDatabaseUrl)("instant café V1 workspace", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>, paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "projects", "chat_cases", "try_seeds"); paypal = new FakePayPal(); });
  afterAll(() => handle?.pool.end());
  const deps = (): TryDeps => ({ db: handle.db, paypal, links, perHour: 30, testCard: (id, options) => paypal.confirmWithTestCard(id, options) });
  async function start() {
    const run = await startTry(deps(), null, { scenario: HOME_SCENARIO });
    if (run.kind === "limited") throw new Error("Expected a local project");
    return run;
  }
  async function finish(session: string) {
    for (let count = 0; count < 12; count++) {
      const result = await prepareTry(deps(), session, session);
      if (result.kind === "ready") return result.seed;
      if (result.kind === "failed" || result.kind === "not_found") throw new Error("Payment preparation did not finish");
    }
    throw new Error("Preparation did not complete");
  }

  it("opens the approved V1 and full discussion immediately, with no provider calls or invented V2", async () => {
    const run = await start();
    expect(run.seed).toMatchObject({ status: "seeding", workspaceReady: true, baselineQuoteVersion: 1, scenarioVersion: 4, changeOrderId: null });
    expect(run.seed.stages.filter((stage) => stage.status === "done").map((stage) => stage.id)).toEqual(["quote", "discussion"]);
    // Both services and the four product holds do not depend on each other, so they run as one stage. The
    // countertop was paid at templating and the tile on delivery, so each records its supplier step and is captured.
    expect(run.seed.stages.map((stage) => stage.id)).toEqual(["quote", "starting_payments", "countertop_supplier", "countertop_capture", "wall_tile_supplier", "wall_tile_capture", "fees", "discussion"]);
    expect(paypal.calls).toHaveLength(0);
    const chat = await createChatStore(handle.db).getCase(run.session, "maple");
    expect(chat.quote).toEqual(HOME_APPROVED_QUOTE);
    expect(chat.versions).toEqual([]);
    expect(chat.draft).toBeNull();
    expect(chat.messages.filter((message) => message.model === "demo-scenario-discussion").map(({ actor, text }) => ({ actor, text }))).toEqual(HOME_DISCUSSION);
    const opening = await readOpening(handle.db, (await findProject(handle.db, run.session, "maple"))!);
    expect(opening.opening).toMatchObject({ version: 1, status: "approved", closed: false, progress: { approved: 6, pending: 0 } });
    expect(opening.revision?.status).toBe("sent");
    expect(opening.decisions.size).toBe(6);
    expect(opening.lineIds.size).toBe(6);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect((await handle.db.select().from(revisions)).map((revision) => revision.number)).toEqual([1]);
  });

  it("prepares the paid V1 design fee and site visits, four product holds and the countertop and tile captures", async () => {
    const run = await start(), ready = await finish(run.session);
    expect(ready).toMatchObject({ status: "ready", workspaceReady: true, baselineQuoteVersion: 1, changeOrderId: null });
    // One services hold and its two captures, then the four product holds.
    expect(ready.stages.find((stage) => stage.id === "starting_payments")?.operationIds).toHaveLength(7);
    const [bridge] = await handle.db.select().from(pricingCases);
    const ledger = await readLedger(handle.db, bridge.projectId);
    expect(ledger.authorizations).toHaveLength(5);
    expect(ledger.authorizations.reduce((sum, hold) => sum + hold.amountCents, 0)).toBe(1_106_000);
    expect(ledger.captures.map((capture) => capture.amountCents).sort((a, b) => a - b)).toEqual([72_000, 98_000, 240_000, 396_000]);
    expect(ready.stages.find((stage) => stage.id === "countertop_capture")?.operationIds).toHaveLength(1);
    expect(ready.stages.find((stage) => stage.id === "wall_tile_capture")?.operationIds).toHaveLength(1);
    // Emma paid the V1 design fee with the Sandbox test card and saved it for the project's later holds.
    expect(await servicesPaymentView(handle.db, run.session, "maple", findAccount("emma")!, "test-client-id")).toMatchObject({
      basis: { version: 1, orderId: null }, dueCents: 0, canPay: false, savedPayPal: true, savedMethod: { kind: "card", label: "Visa •••• 0026" }, canRemoveSaved: true,
    });
    expect(ledger.operations.every((operation) => operation.changeOrderId === null && operation.revisionId === bridge.baselineRevisionId)).toBe(true);
    const chat = await createChatStore(handle.db).getCase(run.session, "maple");
    expect(chat.quote?.version).toBe(1);
    expect(chat.versions).toEqual([]);
    const calls = paypal.calls.length;
    expect((await startTry(deps(), run.session, { scenario: HOME_SCENARIO })).kind).toBe("ready");
    expect(paypal.calls).toHaveLength(calls);
  });

  it("allows AI and saved pricing during preparation, then issues and confirms the first revision as V2", async () => {
    const run = await start(), chat = createChatStore(handle.db), pricing = createPricingStore(handle.db);
    const prepared = await chat.getCase(run.session, "maple"), requestId = randomUUID();
    const discussion = prepared.messages.filter((message) => message.model === "demo-scenario-discussion");
    await chat.appendMessage(run.session, "maple", { id: requestId, actor: "designer", text: HOME_DESIGNER_REQUEST });
    const output: AiOutput = { intent: "draft", message: "Draft for review", title: "Window bay and back bar revision", unresolved: [], constraints: [], changes: [
      { action: "add", itemId: null, quantity: 16, productOptionId: HOME_PRODUCT_IDS.windowCounter, description: "", sourceMessageIds: [discussion[1].id] },
      { action: "quantity", itemId: "stools", quantity: 14, productOptionId: null, description: "", sourceMessageIds: [discussion[2].id] },
      { action: "add", itemId: null, quantity: 12, productOptionId: HOME_PRODUCT_IDS.panels, description: "", sourceMessageIds: [discussion[5].id] },
      { action: "quantity", itemId: "countertop", quantity: 18, productOptionId: null, description: "", sourceMessageIds: [discussion[7].id] },
      { action: "quantity", itemId: "pendants", quantity: 4, productOptionId: null, description: "", sourceMessageIds: [discussion[9].id] },
      { action: "replace", itemId: "wall-tile", quantity: 20, productOptionId: HOME_PRODUCT_IDS["wall-tile"], description: "", sourceMessageIds: [discussion[13].id] },
      { action: "quantity", itemId: "site-visits", quantity: 6, productOptionId: null, description: "", sourceMessageIds: [discussion[16].id] },
    ] };
    const state = await runCaseAi(chat, run.session, "maple", requestId, { configured: () => true, callModel: async () => ({ output, model: "stub-external-model" }) });
    const draft = state.draft!, input = createPricingInput(state.quote!, draft);
    expect(draft.basedOnVersion).toBe(1);
    expect(previewPricing(state.quote!, draft, input).proposedTotals?.totalCents).toBe(1_750_600);
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues.forEach((issue) => { issue.resolved = true; });
    input.reviewNotes = "Verified supplier documents and seven changes.";
    const saved = await pricing.saveReview(run.session, "maple", { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: null, input });
    const command = { reviewId: saved.review!.id, expectedVersion: saved.review!.version };
    await expect(pricing.issueReview(run.session, "maple", command)).rejects.toMatchObject({ code: "PREPARATION_PENDING" });
    expect(paypal.calls).toHaveLength(0);
    await finish(run.session);
    const { order } = await pricing.issueReview(run.session, "maple", command);
    expect(order).toMatchObject({ version: 2, basedOnVersion: 1, totals: { totalCents: 1_750_600 } });
    expect((await handle.db.select().from(revisions)).map((revision) => revision.number).sort()).toEqual([1, 2]);
    const providerCalls = paypal.calls.length;
    await createApprovalStore(handle.db).decide(run.session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: "Checked V2." });
    const payments = (await paymentsWorkspace(handle.db, run.session, order.id, new Date(), findAccount("jordan")!))!;
    expect(payments.plan?.blockers).toEqual([]);
    const actions = payments.plan!.actions;
    const has = (itemId: string, side: "baseline" | "proposed", kind: string, amountCents: number, timing: string) =>
      expect(actions).toContainEqual(expect.objectContaining({ itemId, side, kind, amountCents, timing }));
    // One signature, a different PayPal step for each line.
    has("countertop", "baseline", "refund", 44_000, "after_vendor_credit");            // 4 ft credited, less the $280 re-cut fee
    has("wall-tile", "baseline", "refund", 78_400, "after_vendor_credit");             // white tile returned, less 20%
    has("wall-tile", "proposed", "new_authorization", 152_000, "on_payment_execution"); // sage tile held
    has("pendants", "baseline", "capture", 96_000, "after_vendor_confirmation");       // four kept
    has("pendants", "baseline", "release_authorization", 48_000, "after_vendor_confirmation");
    has("stools", "baseline", "new_authorization", 117_000, "on_payment_execution");   // six more on top of the eight held
    has("stools", "baseline", "capture", 156_000, "after_vendor_confirmation");
    has("site-visits", "baseline", "capture", 36_000, "on_payment_execution");         // two extra visits, paid by the client
    const added = actions.filter((action) => action.itemId.startsWith("new-"));
    expect(added.map((action) => [action.kind, action.amountCents, action.timing])).toEqual([["new_authorization", 336_000, "on_payment_execution"], ["new_authorization", 174_000, "on_payment_execution"]]);
    expect(actions).toHaveLength(10);
    expect(paypal.calls).toHaveLength(providerCalls);
    expect(payments.plan?.actions.some((action) => action.itemId === "design")).toBe(false);
    // The two extra site visits are the only service money due; the design fee was paid in V1.
    expect(await servicesPaymentView(handle.db, run.session, "maple", findAccount("emma")!, "test-client-id")).toMatchObject({
      basis: { version: 2, orderId: order.id }, dueCents: 36_000, canPay: true, furnitureToHold: { count: 4, cents: 779_000 },
      services: [expect.objectContaining({ itemId: "design", targetCents: 240_000, capturedCents: 240_000 }), expect.objectContaining({ itemId: "site-visits", targetCents: 108_000, capturedCents: 72_000 })],
    });
    const ref = { itemId: "wall-tile", side: "proposed" as const, contentHash: order.contentHash, revisionContentHash: order.revisionContentHash };
    const checkout = await startAuthorization(handle.db, paypal, run.session, order.id, ref, links);
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    const calls = paypal.calls.length;
    expect((await startAuthorization(handle.db, paypal, run.session, order.id, ref, links)).id).toBe(checkout.id);
    expect(paypal.calls).toHaveLength(calls);
    const after = (await paymentsWorkspace(handle.db, run.session, order.id, new Date(), findAccount("emma")!))!;
    const proposed = after.lines.filter((line) => line.side === "proposed");
    expect(proposed.find((line) => line.itemId === "wall-tile")?.heldCents).toBe(152_000);
    expect(proposed.filter((line) => line.itemId.startsWith("new-")).map((line) => line.heldCents)).toEqual([0, 0]);
  });

  it("recovers the same V1 operation after a lost response without repeating the discussion", async () => {
    const run = await start();
    paypal.then("lose-response");
    expect((await prepareTry(deps(), run.session, run.session)).kind).toBe("failed");
    const [operation] = await handle.db.select().from(paymentOperations);
    await finish(run.session);
    const calls = paypal.calls.length;
    const [seed] = await handle.db.select().from(trySeeds).where(eq(trySeeds.sessionId, run.session));
    await handle.db.update(trySeeds).set({ status: "seeding", stages: seed.stages.map((stage) => stage.id === "starting_payments" ? { ...stage, status: "pending" as const } : stage) }).where(eq(trySeeds.sessionId, run.session));
    await finish(run.session);
    expect(paypal.calls).toHaveLength(calls);
    const operations = await handle.db.select().from(paymentOperations);
    // Seven starting payments, then the countertop and tile captures.
    expect(operations).toHaveLength(9);
    expect(operations.some((candidate) => candidate.id === operation.id)).toBe(true);
    expect((await createChatStore(handle.db).getCase(run.session, "maple")).messages.filter((message) => message.model === "demo-scenario-discussion")).toHaveLength(HOME_DISCUSSION.length);
  });
});
