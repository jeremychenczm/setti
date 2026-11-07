import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDraft } from "../ai/draft";
import { createChatStore } from "../chat/store";
import { chatCases } from "../chat/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { approvals, paymentOperations, paypalAuthorizations, paypalCaptures, revisions } from "../db/schema";
import { createPricingStore } from "../pricing/store";
import { createPricingInput } from "../pricing/calculation";
import { pricingCases } from "../pricing/schema";
import { itemMappingKey } from "../pricing/document";
import type { FrozenChangeOrder, PricingWorkspace } from "../pricing/types";
import { quoteFingerprint } from "../quotes/fingerprint";
import { changeOrderDecisions } from "./schema";
import { createApprovalStore } from "./store";
import type { DecideChangeOrderInput } from "./types";
import { clientSignatureName } from "../opening/types";

describe.skipIf(!testDatabaseUrl)("whole-document client decisions", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "projects", "chat_cases");
    session = randomUUID();
  });
  afterAll(() => handle?.pool.end());

  async function draftAndReview(quantity?: number) {
    const chat = createChatStore(handle.db), pricing = createPricingStore(handle.db);
    const state = await chat.getCase(session, "maple"), quote = state.quote!;
    const chair = quote.lines.find((line) => line.itemId === "chair")!;
    const id = randomUUID();
    await chat.appendMessage(session, "maple", { id, actor: "client", text: `@Coordinator set chairs to ${quantity ?? chair.quantity + 1}` });
    const run = await chat.beginAi(session, "maple", id);
    if (run.status !== "started") throw new Error("Expected AI run");
    const result = buildDraft({ quote, messages: run.state.messages, pages: [], current: null, triggerId: id, model: "test-model", output: {
      intent: "draft", message: "Chair quantity draft", title: "Reviewed chair quantity", changes: [{ action: "quantity", itemId: chair.itemId, quantity: quantity ?? chair.quantity + 1, productOptionId: null, description: "", sourceMessageIds: [id] }], unresolved: [], constraints: ["All other items unchanged."],
    } });
    await chat.completeAi(session, "maple", id, run.runId, { ...result, model: "test-model" });
    const initial = await pricing.getWorkspace(session, "maple"), review = initial.review!;
    const input = createPricingInput(quote, result.draft!);
    input.terms = "Demo client confirms this complete quote; payment is a separate step.";
    input.reviewNotes = "Checked test amounts and terms.";
    input.changes = input.changes.map((change) => ({ ...change, confirmed: true, priceEvidence: "Demonstration price reviewed for testing.", after: change.after ? { ...change.after, taxCents: 0, freightCents: 0, currency: "USD", sku: change.after.sku || "DEMO", returnable: true, returnPolicy: "Demo test return terms checked." } : null, oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "No old-item handling required for this increase." }));
    input.issues = input.issues.map((issue) => ({ ...issue, resolved: true, note: "Checked in this test fixture." }));
    return pricing.saveReview(session, "maple", { sourceDraftId: result.draft!.id, sourceDraftRevision: result.draft!.revision, expectedVersion: review.version || null, input });
  }

  async function issue(workspace: PricingWorkspace) {
    return (await createPricingStore(handle.db).issueReview(session, "maple", { reviewId: workspace.review!.id, expectedVersion: workspace.review!.version })).order;
  }
  function command(order: FrozenChangeOrder, changes = false): DecideChangeOrderInput {
    return { decision: changes ? "changes_requested" : "approved", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash, acknowledged: true, signature: clientSignatureName(order), note: changes ? "Please review the proposed chair count." : "" };
  }

  it("keeps shared links read-only and rejects another session", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    const shared = await store.getWorkspace(null, order.id);
    expect(shared).toMatchObject({ canDecide: false, clientName: null, fundingPlan: null });
    expect((await store.getWorkspace(session, order.id))?.canDecide).toBe(true);
    await expect(store.decide(randomUUID(), order.id, command(order))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await handle.db.select().from(changeOrderDecisions)).toHaveLength(0);
  });

  it("atomically confirms every line once, persists the receipt and never creates payments", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    const [a, b] = await Promise.all([store.decide(session, order.id, command(order)), store.decide(session, order.id, command(order))]);
    expect(a.view.status).toBe("approved");
    expect(a.view.decision?.id).toBe(b.view.decision?.id);
    expect(await handle.db.select().from(changeOrderDecisions)).toHaveLength(1);
    expect(await handle.db.select().from(approvals).where(eq(approvals.revisionId, order.revisionId))).toHaveLength(order.lines.length);
    expect((await store.getWorkspace(session, order.id))?.view).toEqual(a.view);
    expect(a.fundingPlan?.status).toBe("not_authorized");
    expect(a.fundingPlan?.current).toEqual({ heldCents: 0, capturedCents: 0, refundedCents: 0 });
    expect(a.fundingPlan!.money.newAuthorizationCents! + a.fundingPlan!.money.chargeCents!).toBe(order.totals.totalCents);
    expect(a.fundingPlan!.money.newAuthorizationCents! + a.fundingPlan!.money.chargeCents!).not.toBe(order.deltaTotalCents);
    expect(await handle.db.select().from(paypalAuthorizations)).toHaveLength(0);
    expect(await handle.db.select().from(paypalCaptures)).toHaveLength(0);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
    expect((await store.getWorkspace(null, order.id))?.fundingPlan).toBeNull();
    const chat = await createChatStore(handle.db).getCase(session, "maple");
    expect(chat.draft).toBeNull();
    expect(chat.quote).toMatchObject({ id: order.id, version: order.version });
    expect(chat.messages.at(-1)?.text).toContain("No payment has been executed");
  });

  it("shows an owning client's funding preview before approval without creating a decision or payment", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    const before = await store.getWorkspace(session, order.id);
    expect(before).toMatchObject({ canDecide: true, view: { status: "awaiting_client_confirmation", decision: null } });
    expect(before?.fundingPlan).toMatchObject({ executable: false, status: "not_authorized", orderId: order.id });
    expect(before!.fundingPlan!.money.newAuthorizationCents! + before!.fundingPlan!.money.chargeCents!).toBe(order.totals.totalCents);
    expect(await handle.db.select().from(changeOrderDecisions)).toHaveLength(0);
    expect(await handle.db.select().from(paymentOperations)).toHaveLength(0);
    expect((await store.getWorkspace(randomUUID(), order.id))?.fundingPlan).toBeNull();
    expect((await store.getWorkspace(null, order.id))?.fundingPlan).toBeNull();
  });

  it("checks both hashes, signed name and acknowledgement before recording a decision", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db), body = command(order);
    for (const input of [{ ...body, contentHash: "0".repeat(64) }, { ...body, revisionContentHash: "0".repeat(64) }]) await expect(store.decide(session, order.id, input)).rejects.toMatchObject({ code: "CONTENT_CHANGED" });
    await expect(store.decide(session, order.id, { ...body, signature: "Some other person" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(store.decide(session, order.id, { ...body, acknowledged: false } as unknown as DecideChangeOrderInput)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await handle.db.select().from(changeOrderDecisions)).toHaveLength(0);
  });

  it("rejects a superseded version and records adjustments without advancing the baseline", async () => {
    const workspace = await draftAndReview(), old = await issue(workspace), pricing = createPricingStore(handle.db), store = createApprovalStore(handle.db);
    const review = workspace.review!;
    const updated = await pricing.saveReview(session, "maple", { sourceDraftId: review.sourceDraftId, sourceDraftRevision: review.sourceDraftRevision, expectedVersion: review.version, input: { ...review.input, title: "Updated chair review" } });
    const latest = await issue(updated);
    expect((await store.getWorkspace(session, old.id))?.fundingPlan).toBeNull();
    await expect(store.decide(session, old.id, command(old))).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(store.decide(session, latest.id, { ...command(latest, true), note: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const result = await store.decide(session, latest.id, command(latest, true));
    expect(result.view.status).toBe("declined"); expect(result.fundingPlan).toBeNull();
    expect((await createChatStore(handle.db).getCase(session, "maple")).quote?.version).toBe(1);
    await expect(store.decide(session, latest.id, command(latest))).rejects.toMatchObject({ code: "DECISION_CONFLICT" });
  });

  it("uses the accepted version for the next AI draft, review and business revision", async () => {
    const first = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    await store.decide(session, first.id, command(first));
    const secondWorkspace = await draftAndReview();
    expect(secondWorkspace.quote.id).toBe(first.id);
    expect(secondWorkspace.sourceDraft?.basedOnQuoteFingerprint).toBe(quoteFingerprint(secondWorkspace.quote));
    const second = await issue(secondWorkspace);
    expect(second.basedOnVersion).toBe(first.version);
    expect(second.baselineTotals).toEqual(first.totals);
    const [revision] = await handle.db.select().from(revisions).where(eq(revisions.id, second.revisionId));
    expect(revision.basedOnRevisionId).toBe(first.revisionId);
    await store.decide(session, second.id, command(second));
    const chat = await createChatStore(handle.db).getCase(session, "maple");
    expect(chat.quote?.version).toBe(second.version);
    expect((await store.getWorkspace(session, first.id))?.view).toMatchObject({ status: "superseded", decision: { decision: "approved" } });
    expect((await store.getWorkspace(session, first.id))?.fundingPlan).toBeNull();
    expect((await createChatStore(handle.db).getCase(randomUUID(), "maple")).quote?.version).toBe(1);
  });

  it("prevents changing decision history and rejects an incomplete direct DB decision", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    await expect(handle.db.insert(changeOrderDecisions).values({ orderId: order.id, revisionId: order.revisionId, sessionId: session, decision: "approved", clientName: order.clientName, signature: order.clientName, note: "", contentHash: order.contentHash, revisionContentHash: order.revisionContentHash })).rejects.toThrow();
    await store.decide(session, order.id, command(order));
    await expect(handle.db.update(changeOrderDecisions).set({ note: "Changed later" }).where(eq(changeOrderDecisions.orderId, order.id))).rejects.toThrow();
    await expect(handle.db.delete(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, order.id))).rejects.toThrow();
  });

  it("recovers an expired AI lease but blocks confirmation while a live run is active", async () => {
    const order = await issue(await draftAndReview()), chat = createChatStore(handle.db), store = createApprovalStore(handle.db), messageId = randomUUID();
    await chat.appendMessage(session, "maple", { id: messageId, actor: "client", text: "@Coordinator Explain this draft." });
    await chat.beginAi(session, "maple", messageId);
    expect((await store.getWorkspace(session, order.id))?.canDecide).toBe(false);
    await expect(store.decide(session, order.id, command(order))).rejects.toMatchObject({ code: "CASE_BUSY" });
    await handle.db.update(chatCases).set({ activeRunStartedAt: new Date(Date.now() - 181_000) }).where(eq(chatCases.sessionId, session));
    expect((await store.getWorkspace(session, order.id))?.canDecide).toBe(true);
    expect((await store.decide(session, order.id, command(order))).view.status).toBe("approved");
  });

  it("reads allocated ledger records and blocks unresolved payment results", async () => {
    const order = await issue(await draftAndReview()), store = createApprovalStore(handle.db);
    const [bridge] = await handle.db.select().from(pricingCases);
    const chair = order.baselineLines.find((line) => line.itemId === "chair")!;
    const itemId = bridge.itemMapping[itemMappingKey({ ...chair, sourceUrl: chair.source.url ?? null })];
    const [authorization] = await handle.db.insert(paypalAuthorizations).values({ projectId: bridge.projectId, itemId, paypalOrderId: `TEST-${randomUUID()}`, paypalAuthorizationId: `TEST-${randomUUID()}`, amountCents: 10_000, status: "created", expiresAt: new Date(Date.now() + 86400_000) }).returning();
    const result = await store.decide(session, order.id, command(order));
    expect(result.fundingPlan?.status).toBe("preview");
    expect(result.fundingPlan?.current.heldCents).toBe(10_000);
    await handle.db.insert(paymentOperations).values({ id: randomUUID(), businessKey: `test:${randomUUID()}`, projectId: bridge.projectId, authorizationId: authorization.id, kind: "capture", amountCents: 100, status: "unknown", requestId: randomUUID() });
    const pending = await store.getWorkspace(session, order.id);
    expect(pending?.fundingPlan?.status).toBe("blocked");
    expect(pending?.fundingPlan?.money.newAuthorizationCents).toBeNull();
  });
});
