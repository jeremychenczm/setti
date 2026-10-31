import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountOrDefault } from "../accounts/demo";
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

describe.skipIf(!testDatabaseUrl)("instant living-and-dining V1 workspace", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>, paypal: FakePayPal;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "projects", "chat_cases", "try_seeds"); paypal = new FakePayPal(); });
  afterAll(() => handle?.pool.end());
  const deps = (): TryDeps => ({ db: handle.db, paypal, links, perHour: 30, testCard: (id) => paypal.confirmWithTestCard(id) });
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
    expect(run.seed).toMatchObject({ status: "seeding", workspaceReady: true, baselineQuoteVersion: 1, scenarioVersion: 3, changeOrderId: null });
    expect(run.seed.stages.filter((stage) => stage.status === "done").map((stage) => stage.id)).toEqual(["quote", "discussion"]);
    expect(paypal.calls).toHaveLength(0);
    const chat = await createChatStore(handle.db).getCase(run.session, "maple");
    expect(chat.quote).toEqual(HOME_APPROVED_QUOTE);
    expect(chat.versions).toEqual([]);
    expect(chat.draft).toBeNull();
    expect(chat.messages.filter((message) => message.model === "demo-scenario-discussion").map(({ actor, text }) => ({ actor, text }))).toEqual(HOME_DISCUSSION);
    const opening = await readOpening(handle.db, chat);
    expect(opening.opening).toMatchObject({ version: 1, status: "approved", closed: false, progress: { approved: 6, pending: 0 } });
    expect(opening.revision?.status).toBe("sent");
    expect(opening.decisions.size).toBe(6);
    expect(opening.lineIds.size).toBe(6);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
    expect((await handle.db.select().from(revisions)).map((revision) => revision.number)).toEqual([1]);
  });

  it("prepares the paid V1 design fee, five furniture holds and the sideboard capture", async () => {
    const run = await start(), ready = await finish(run.session);
    expect(ready).toMatchObject({ status: "ready", workspaceReady: true, baselineQuoteVersion: 1, changeOrderId: null });
    const [bridge] = await handle.db.select().from(pricingCases);
    const ledger = await readLedger(handle.db, bridge.projectId);
    expect(ledger.authorizations).toHaveLength(6);
    expect(ledger.authorizations.reduce((sum, hold) => sum + hold.amountCents, 0)).toBe(773_000);
    expect(ledger.captures.map((capture) => capture.amountCents).sort((a, b) => a - b)).toEqual([100_000, 120_000]);
    expect(await servicesPaymentView(handle.db, run.session, "maple", accountOrDefault("emma"), "test-client-id")).toMatchObject({ basis: { version: 1, orderId: null }, dueCents: 0, canPay: false, savedPayPal: false });
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
    const output: AiOutput = { intent: "draft", message: "Draft for review", title: "Living and dining revision", unresolved: [], constraints: [], changes: [
      { action: "replace", itemId: "sofa", quantity: 1, productOptionId: HOME_PRODUCT_IDS.sofa, description: "", sourceMessageIds: [discussion[4].id] },
      { action: "replace", itemId: "coffee-table", quantity: 2, productOptionId: HOME_PRODUCT_IDS["coffee-table"], description: "", sourceMessageIds: [discussion[6].id] },
      { action: "replace", itemId: "dining-table", quantity: 1, productOptionId: HOME_PRODUCT_IDS["dining-table"], description: "", sourceMessageIds: [discussion[10].id] },
      { action: "quantity", itemId: "dining-chairs", quantity: 4, productOptionId: null, description: "", sourceMessageIds: [discussion[12].id] },
      { action: "remove", itemId: "sideboard", quantity: null, productOptionId: null, description: "", sourceMessageIds: [discussion[14].id] },
    ] };
    const state = await runCaseAi(chat, run.session, "maple", requestId, { configured: () => true, callModel: async () => ({ output, model: "stub-external-model" }) });
    const draft = state.draft!, input = createPricingInput(state.quote!, draft);
    expect(draft.basedOnVersion).toBe(1);
    expect(previewPricing(state.quote!, draft, input).proposedTotals?.totalCents).toBe(567_000);
    input.changes.forEach((change) => { change.confirmed = true; });
    input.issues.forEach((issue) => { issue.resolved = true; });
    input.reviewNotes = "Verified supplier documents and five changes.";
    const saved = await pricing.saveReview(run.session, "maple", { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: null, input });
    const command = { reviewId: saved.review!.id, expectedVersion: saved.review!.version };
    await expect(pricing.issueReview(run.session, "maple", command)).rejects.toMatchObject({ code: "PREPARATION_PENDING" });
    expect(paypal.calls).toHaveLength(0);
    await finish(run.session);
    const { order } = await pricing.issueReview(run.session, "maple", command);
    expect(order).toMatchObject({ version: 2, basedOnVersion: 1, totals: { totalCents: 567_000 } });
    expect((await handle.db.select().from(revisions)).map((revision) => revision.number).sort()).toEqual([1, 2]);
    const providerCalls = paypal.calls.length;
    await createApprovalStore(handle.db).decide(run.session, order.id, { decision: "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: "Checked V2." });
    const payments = (await paymentsWorkspace(handle.db, run.session, order.id, new Date(), accountOrDefault("jordan")))!;
    expect(payments.plan?.blockers).toEqual([]);
    expect(payments.plan?.actions).toContainEqual(expect.objectContaining({ itemId: "sideboard", kind: "refund", amountCents: 96_000, timing: "after_vendor_credit" }));
    expect(payments.plan?.actions).toContainEqual(expect.objectContaining({ itemId: "dining-chairs", kind: "capture", amountCents: 72_000 }));
    expect(paypal.calls).toHaveLength(providerCalls);
    expect(payments.plan?.actions.some((action) => action.itemId === "design")).toBe(false);
    expect(await servicesPaymentView(handle.db, run.session, "maple", accountOrDefault("emma"), "test-client-id")).toMatchObject({ basis: { version: 2, orderId: order.id }, dueCents: 0, canPay: false, services: [expect.objectContaining({ targetCents: 100_000, capturedCents: 100_000 })] });
    const ref = { itemId: "sofa", side: "proposed" as const, contentHash: order.contentHash, revisionContentHash: order.revisionContentHash };
    const checkout = await startAuthorization(handle.db, paypal, run.session, order.id, ref, links);
    paypal.approve(checkout.paypalOrderId!);
    expect((await completeAuthorization(handle.db, paypal, checkout.id)).state).toBe("authorized");
    const calls = paypal.calls.length;
    expect((await startAuthorization(handle.db, paypal, run.session, order.id, ref, links)).id).toBe(checkout.id);
    expect(paypal.calls).toHaveLength(calls);
    const after = (await paymentsWorkspace(handle.db, run.session, order.id, new Date(), accountOrDefault("emma")))!;
    expect(after.lines.filter((line) => line.side === "proposed").map((line) => [line.itemId, line.heldCents])).toEqual(expect.arrayContaining([["sofa", 210_000], ["coffee-table", 0], ["dining-table", 0]]));
  });

  it("recovers the same V1 operation after a lost response without repeating the discussion", async () => {
    const run = await start();
    paypal.then("lose-response");
    expect((await prepareTry(deps(), run.session, run.session)).kind).toBe("failed");
    const [operation] = await handle.db.select().from(paymentOperations);
    await finish(run.session);
    const calls = paypal.calls.length;
    const [seed] = await handle.db.select().from(trySeeds).where(eq(trySeeds.sessionId, run.session));
    await handle.db.update(trySeeds).set({ status: "seeding", stages: seed.stages.map((stage) => ["design_services", "sofa_hold"].includes(stage.id) ? { ...stage, status: "pending" as const } : stage) }).where(eq(trySeeds.sessionId, run.session));
    await finish(run.session);
    expect(paypal.calls).toHaveLength(calls);
    const operations = await handle.db.select().from(paymentOperations);
    expect(operations).toHaveLength(8);
    expect(operations.some((candidate) => candidate.id === operation.id)).toBe(true);
    expect((await createChatStore(handle.db).getCase(run.session, "maple")).messages.filter((message) => message.model === "demo-scenario-discussion")).toHaveLength(19);
  });
});
