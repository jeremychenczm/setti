import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { approvals, items, paymentOperations, paypalAuthorizations, paypalCaptures, paypalRefunds, projects, revisionLines, revisions } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { createChatStore } from "../chat/store";
import { preapprovedQuote } from "../chat/cases";
import { signOpeningForTest } from "../opening/testing";
import { addTestProject, CHAIR, TEST_KEY } from "../projects/testing";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { CaseKey, ChangeDraft } from "../chat/types";
import { createPricingInput } from "./calculation";
import { changeOrders, pricingCases, pricingReviews } from "./schema";
import { changeOrderContentHash, createPricingStore } from "./store";
import { quoteTitle } from "./title";
import type { PricingInput, PricingStore, PricingWorkspace } from "./types";

describe.skipIf(!testDatabaseUrl)("persisted designer pricing reviews", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let store: PricingStore;
  let sessionId: string;

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "change_orders", "pricing_reviews", "pricing_cases", "chat_messages", "chat_cases", "approvals", "revision_lines", "revisions", "items", "projects");
    store = createPricingStore(handle.db);
    sessionId = randomUUID();
  });
  afterAll(() => handle?.pool.end());

  async function seed(key: CaseKey = "maple", action: "quantity" | "replace" = "quantity") {
    if (key === TEST_KEY) {
      await addTestProject(handle.db, sessionId);
      await signOpeningForTest(handle.db, sessionId, key);
    }
    const quote = (await createChatStore(handle.db).getCase(sessionId, key)).quote!;
    const old = quote.lines.find((line) => line.itemId === (key === "maple" ? "chair" : CHAIR))!;
    const before = { name: old.name, vendor: old.vendor, brand: null, sku: old.sku, specification: old.specification, quantity: old.quantity, unitLabel: old.unitLabel ?? "each", unitPriceCents: old.unitPriceCents, currency: "USD" };
    const after = action === "quantity" ? { ...before, quantity: old.quantity + 1 } : {
      ...before, name: "BERGMUND Chair", vendor: "IKEA US (test reference)", sku: "TEST-BERGMUND", specification: "Test-only replacement option", quantity: 1, unitPriceCents: 9_500,
    };
    const chat = createChatStore(handle.db);
    const messageId = randomUUID();
    await chat.appendMessage(sessionId, key, { id: messageId, actor: "client", text: `@Setti ${action === "quantity" ? "Increase the chair quantity." : "Replace the dining chairs with BERGMUND for review."}` });
    const now = new Date().toISOString();
    const draft: ChangeDraft = {
      id: randomUUID(), projectKey: key, basedOnQuoteId: quote.id, basedOnVersion: quote.version, basedOnQuoteFingerprint: quoteFingerprint(quote), revision: 1,
      status: "needs_designer_review", title: "Chair update", summary: "A test-only AI draft.",
      changes: [{ action, itemId: old.itemId, before, after, productOptionId: null, sourceMessageIds: [messageId], beforeSubtotalCents: old.quantity * old.unitPriceCents, afterSubtotalCents: after.quantity * after.unitPriceCents, deltaSubtotalCents: after.quantity * after.unitPriceCents - old.quantity * old.unitPriceCents }],
      sourceMessageIds: [messageId], sources: [], unresolved: ["Verify tax, delivery and old item handling."], constraints: ["Do not order or pay before client confirmation."],
      deltaSubtotalCents: after.quantity * after.unitPriceCents - old.quantity * old.unitPriceCents, createdAt: now, updatedAt: now, model: "test-model",
    };
    const run = await chat.beginAi(sessionId, key, messageId);
    if (run.status !== "started") throw new Error("Expected an AI run");
    await chat.completeAi(sessionId, key, messageId, run.runId, { text: "Draft prepared for designer review.", draft, model: "test-model" });
    return { draft, messageId, quote, key, workspace: await store.getWorkspace(sessionId, key) };
  }

  function readyInput(input: PricingInput): PricingInput {
    return {
      ...structuredClone(input), title: "Reviewed chair update", terms: "Demo quote only. Await client confirmation; no order or payment is made.", reviewNotes: "Designer review is a demonstration.",
      changes: input.changes.map((change) => ({
        ...structuredClone(change), confirmed: true, priceEvidence: "Checked against the demonstration source; not a real vendor quote.",
        after: change.after ? { ...structuredClone(change.after), sku: change.after.sku || "DEMO-TEST", taxCents: 0, freightCents: 0, currency: "USD", returnable: true, returnPolicy: "Demonstration return terms explicitly checked for this test." } : null,
        oldItemHandling: change.action === "remove" || change.action === "replace" ? "not_ordered" : "not_applicable",
        oldItemCostCents: 0, oldItemNote: "Demo old item has not been ordered; no handling cost.",
      })),
      issues: input.issues.map((issue) => ({ ...issue, resolved: true, note: "Checked for this demonstration; no purchase made." })),
    };
  }

  async function saveReady(workspace: PricingWorkspace) {
    const review = workspace.review!;
    return store.saveReview(sessionId, workspace.projectKey, { sourceDraftId: review.sourceDraftId, sourceDraftRevision: review.sourceDraftRevision, expectedVersion: review.version === 0 ? null : review.version, input: readyInput(review.input) });
  }

  async function issue(workspace: PricingWorkspace) {
    return store.issueReview(sessionId, workspace.projectKey, { reviewId: workspace.review!.id, expectedVersion: workspace.review!.version });
  }

  it("returns an unsaved version-0 review without importing business records", async () => {
    const seeded = await seed();
    expect(seeded.workspace.review?.version).toBe(0);
    expect(seeded.workspace.preview?.ready).toBe(false);
    expect(seeded.workspace.orders).toEqual([]);
    expect(await handle.db.select().from(pricingReviews)).toHaveLength(0);
    expect(await handle.db.select().from(pricingCases)).toHaveLength(0);
    expect(await handle.db.select().from(projects)).toHaveLength(0);
  });

  it("persists unknown amounts but blocks issue and rejects altered source identities", async () => {
    const { workspace } = await seed();
    const review = workspace.review!;
    const saved = await store.saveReview(sessionId, "maple", { sourceDraftId: review.sourceDraftId, sourceDraftRevision: review.sourceDraftRevision, expectedVersion: null, input: review.input });
    expect(saved.review!.input.changes[0].after!.taxCents).toBeNull();
    expect(saved.preview?.ready).toBe(false);
    await expect(issue(saved)).rejects.toMatchObject({ code: "PRICING_NOT_READY" });
    const tampered = structuredClone(saved.review!.input);
    tampered.changes[0].itemId = "unrelated-item";
    await expect(store.saveReview(sessionId, "maple", { sourceDraftId: review.sourceDraftId, sourceDraftRevision: review.sourceDraftRevision, expectedVersion: 1, input: tampered })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await store.getWorkspace(sessionId, "maple")).review?.version).toBe(1);
    expect(await handle.db.select().from(projects)).toHaveLength(0);
  });

  it("uses optimistic review versions so concurrent edits cannot silently overwrite", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const command = { sourceDraftId: saved.review!.sourceDraftId, sourceDraftRevision: saved.review!.sourceDraftRevision, expectedVersion: saved.review!.version, input: saved.review!.input };
    const results = await Promise.allSettled([
      store.saveReview(sessionId, "maple", { ...command, input: { ...command.input, title: "Edit A" } }),
      store.saveReview(sessionId, "maple", { ...command, input: { ...command.input, title: "Edit B" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected an optimistic-lock conflict");
    expect(rejected.reason.code).toBe("PRICING_CONFLICT");
    expect((await store.getWorkspace(sessionId, "maple")).review?.version).toBe(2);
  });

  it("carries a saved review onto a newer draft, unsaved, until the designer saves it there", async () => {
    const { workspace, draft } = await seed();
    const saved = await saveReady(workspace);
    expect((await handle.db.select().from(pricingReviews))[0].draftProposal).toEqual({ quoteId: preapprovedQuote("maple")!.id, input: workspace.review!.input });
    const newDraft = { ...draft, revision: 2, title: "Updated AI direction" };
    await handle.db.update(chatCases).set({ draft: newDraft }).where(eq(chatCases.id, workspace.caseId));
    const stale = await store.getWorkspace(sessionId, "maple");
    expect(stale.stale).toBe(true);
    expect(stale.review?.input).toEqual(saved.review?.input);
    // The draft only changed its title, which the designer had already rewritten: every edit stays.
    expect(stale.carryOver).toMatchObject({ updated: [], kept: ["Lounge chair"], added: [], removed: [], conflicts: [] });
    expect(stale.carryOver?.input).toEqual(saved.review?.input);
    expect(stale.preview?.ready).toBe(true);
    await expect(issue(saved)).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
    await expect(store.saveReview(sessionId, "maple", { sourceDraftId: draft.id, sourceDraftRevision: 1, expectedVersion: 1, input: saved.review!.input })).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
    const reset = await store.saveReview(sessionId, "maple", { sourceDraftId: newDraft.id, sourceDraftRevision: 2, expectedVersion: 1, input: createPricingInput(preapprovedQuote("maple")!, newDraft) });
    expect(reset.stale).toBe(false);
    expect(reset.review?.id).toBe(saved.review?.id);
    expect(reset.review?.version).toBe(2);
    expect(reset.review?.sourceDraftRevision).toBe(2);
    expect(reset.preview?.ready).toBe(false);
  });

  it("detects same-id/version baseline price drift and never reuses the already-frozen V1", async () => {
    const { workspace, draft } = await seed();
    const saved = await saveReady(workspace);
    const originalOrder = await issue(saved);
    const pending = await store.saveReview(sessionId, "maple", {
      sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: 1,
      input: { ...saved.review!.input, title: "Another review not yet issued" },
    });
    // Change an untouched line of the project's approved V1 while keeping the quote id and version.
    const quote = structuredClone(preapprovedQuote("maple")!);
    quote.lines[0].unitPriceCents += 100;
    await handle.db.update(chatCases).set({ quote }).where(eq(chatCases.id, workspace.caseId));
    {
      const stale = await store.getWorkspace(sessionId, "maple");
      expect(stale.stale).toBe(true);
      expect(stale.preview).toBeNull();
      expect(stale.review?.input).toEqual(pending.review?.input);
      await expect(store.saveReview(sessionId, "maple", {
        sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: 2, input: pending.review!.input,
      })).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
      await expect(issue(pending)).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
      // Replaying an action that was already issued still returns that exact historical document.
      expect((await issue(saved)).order).toEqual(originalOrder.order);

      const freshDraft = { ...draft, revision: draft.revision + 1, basedOnQuoteFingerprint: quoteFingerprint(quote) };
      await handle.db.update(chatCases).set({ draft: freshDraft }).where(eq(chatCases.id, workspace.caseId));
      const reset = await store.saveReview(sessionId, "maple", {
        sourceDraftId: freshDraft.id, sourceDraftRevision: freshDraft.revision, expectedVersion: 2,
        input: readyInput(createPricingInput(quote, freshDraft)),
      });
      expect(reset.stale).toBe(false);
      // Even a newly reviewed draft cannot attach the changed fixture to the old imported V1.
      await expect(issue(reset)).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
      expect(await handle.db.select().from(changeOrders)).toHaveLength(1);
      expect(await handle.db.select().from(revisions)).toHaveLength(2);
    }
    const historical = (await store.getOrder(originalOrder.order.id))!;
    expect(historical.order).toEqual(originalOrder.order);
    const { contentHash, ...document } = historical.order;
    expect(changeOrderContentHash(document)).toBe(contentHash);
  });

  it("marks legacy reviews without a baseline fingerprint stale until an explicit reset", async () => {
    const { workspace, draft } = await seed();
    const saved = await saveReady(workspace);
    const legacyInput: Record<string, unknown> = { ...saved.review!.input };
    delete legacyInput.baselineFingerprint;
    await handle.db.update(pricingReviews).set({ input: legacyInput as unknown as PricingInput, draftProposal: null }).where(eq(pricingReviews.id, saved.review!.id));
    const legacy = await store.getWorkspace(sessionId, "maple");
    expect(legacy.stale).toBe(true);
    expect(legacy.preview).toBeNull();
    await expect(issue(legacy)).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
    await expect(store.saveReview(sessionId, "maple", {
      sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: 1, input: legacyInput as unknown as PricingInput,
    })).rejects.toMatchObject({ code: "PRICING_STALE_SOURCE" });
    const reset = await store.saveReview(sessionId, "maple", {
      sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: 1,
      input: readyInput(createPricingInput(preapprovedQuote("maple")!, draft)),
    });
    expect(reset.stale).toBe(false);
    expect(reset.review?.version).toBe(2);
  });

  it("blocks save and new issue while AI is updating the same case", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const chat = createChatStore(handle.db);
    const messageId = randomUUID();
    await chat.appendMessage(sessionId, "maple", { id: messageId, actor: "client", text: "@Setti Please reconsider the chair." });
    await chat.beginAi(sessionId, "maple", messageId);
    await expect(issue(saved)).rejects.toMatchObject({ code: "PRICING_BUSY" });
    await expect(store.saveReview(sessionId, "maple", { sourceDraftId: saved.review!.sourceDraftId, sourceDraftRevision: 1, expectedVersion: 1, input: saved.review!.input })).rejects.toMatchObject({ code: "PRICING_BUSY" });
  });

  it("issues one full V2 under concurrent requests and imports only labelled demo V1 approvals", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const [first, replay] = await Promise.all([issue(saved), issue(saved)]);
    expect(first.order.id).toBe(replay.order.id);
    expect(first.order.version).toBe(2);
    expect(first.order.lines).toHaveLength(3);
    expect(first.status).toBe("awaiting_client_confirmation");
    const bridge = (await handle.db.select().from(pricingCases))[0];
    const businessVersions = await handle.db.select().from(revisions).where(eq(revisions.projectId, bridge.projectId));
    expect(businessVersions).toHaveLength(2);
    expect(businessVersions.find((revision) => revision.number === 1)?.status).toBe("approved");
    expect(businessVersions.find((revision) => revision.number === 2)?.status).toBe("sent");
    const baselineApprovals = await handle.db.select().from(approvals).where(eq(approvals.revisionId, bridge.baselineRevisionId));
    expect(baselineApprovals).toHaveLength(3);
    expect(baselineApprovals.every((approval) => approval.signature.includes("demo signature"))).toBe(true);
    expect(await handle.db.select().from(approvals).where(eq(approvals.revisionId, first.order.revisionId))).toHaveLength(0);
    const [order] = await handle.db.select().from(changeOrders);
    expect(await handle.db.select().from(changeOrders)).toHaveLength(1);
    // Issuing sends: one designer message carries the version into the chat, and the chat shows its card.
    const sent = (await handle.db.select().from(chatMessages).where(eq(chatMessages.caseId, workspace.caseId))).filter((message) => message.actor === "designer");
    expect(sent.map((message) => message.id)).toEqual([order.messageId]);
    // The version goes by its project and number; the review's own title never reaches the client.
    expect(sent[0].text).toMatch(/^Hi Emma, here is quote V2 for [^.]+\. It changes 1 line, and the new total is \$[\d,.]+ \(\+\$[\d,.]+ against the approved V1\)\. Please review it and confirm\.$/);
    expect(sent[0].text).toContain(`quote V2 for ${first.order.projectName}.`);
    expect(sent[0].text).not.toContain("Reviewed chair update");
    expect(first.order.title).toBe(quoteTitle(first.order));
    expect((await createChatStore(handle.db).getCase(sessionId, "maple")).versions).toEqual([expect.objectContaining({
      id: first.order.id, version: 2, basedOnVersion: 1, messageId: order.messageId, changeCount: 1, status: "awaiting_client_confirmation", fromCurrentDraft: true,
    })]);
    for (const table of [paymentOperations, paypalAuthorizations, paypalCaptures, paypalRefunds]) {
      expect(await handle.db.select().from(table)).toHaveLength(0);
    }
    // An already-issued action remains idempotent even if AI later changes the source.
    await handle.db.update(chatCases).set({ draft: { ...saved.sourceDraft!, revision: 2 } }).where(eq(chatCases.id, workspace.caseId));
    expect((await issue(saved)).order.id).toBe(first.order.id);
  });

  it("keeps sessions and cases private while an opaque order UUID exposes only the frozen public document", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const issued = await issue(saved);
    expect((await store.getWorkspace(randomUUID(), "maple")).review).toBeNull();
    // Another project of the same studio sees none of this one's review.
    await addTestProject(handle.db, sessionId);
    await expect(store.getWorkspace(sessionId, TEST_KEY)).rejects.toMatchObject({ code: "PRICING_NOT_FOUND" });
    await expect(store.issueReview(randomUUID(), "maple", { reviewId: saved.review!.id, expectedVersion: 1 })).rejects.toMatchObject({ code: "PRICING_NOT_FOUND" });
    const publicView = await createPricingStore(handle.db).getOrder(issued.order.id);
    expect(publicView).toEqual(issued);
    expect(JSON.stringify(publicView)).not.toContain(sessionId);
    expect(JSON.stringify(publicView)).not.toContain("sessionId");
    expect(await store.getOrder(randomUUID())).toBeNull();
  });

  it("freezes full contents, supports JSONB hash verification and supersedes the old sent document with V3", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const first = await issue(saved);
    const read = (await store.getOrder(first.order.id))!;
    const { contentHash, ...body } = read.order;
    expect(changeOrderContentHash(body)).toBe(contentHash);
    expect(changeOrderContentHash({ ...body, terms: `${body.terms} Changed.` })).not.toBe(contentHash);
    const renamed = structuredClone(body);
    renamed.lines[0].name = "Changed item name";
    expect(changeOrderContentHash(renamed)).not.toBe(contentHash);
    await expect(handle.db.update(changeOrders).set({ document: { ...read.order, terms: "Tampered" } }).where(eq(changeOrders.id, read.order.id))).rejects.toThrow();
    await expect(handle.db.delete(changeOrders).where(eq(changeOrders.id, read.order.id))).rejects.toThrow();
    await expect(handle.db.update(revisionLines).set({ unitPriceCents: 1 }).where(eq(revisionLines.revisionId, read.order.revisionId))).rejects.toThrow();
    const edited = await store.saveReview(sessionId, "maple", { sourceDraftId: saved.review!.sourceDraftId, sourceDraftRevision: 1, expectedVersion: 1, input: { ...saved.review!.input, title: "Revised commercial terms", terms: "New demo terms for client review." } });
    const next = await issue(edited);
    expect(next.order.version).toBe(3);
    expect(next.status).toBe("awaiting_client_confirmation");
    expect((await store.getOrder(first.order.id))?.status).toBe("superseded");
    expect((await store.getOrder(first.order.id))?.order).toEqual(read.order);
    expect((await issue(saved)).order.id).toBe(first.order.id);
  });

  it("preserves unknown baseline terms and gives replacements a new business item identity", async () => {
    const { workspace } = await seed(TEST_KEY, "replace");
    const saved = await saveReady(workspace);
    const issued = await issue(saved);
    const bridge = (await handle.db.select().from(pricingCases).where(eq(pricingCases.caseId, workspace.caseId)))[0];
    const baseline = await handle.db.select({ itemId: items.id, name: items.name, returnable: revisionLines.returnable }).from(revisionLines)
      .innerJoin(items, eq(items.id, revisionLines.itemId)).where(eq(revisionLines.revisionId, bridge.baselineRevisionId));
    const changed = await handle.db.select({ itemId: items.id, name: items.name }).from(revisionLines)
      .innerJoin(items, eq(items.id, revisionLines.itemId)).where(eq(revisionLines.revisionId, issued.order.revisionId));
    const oldChair = baseline.find((line) => line.name === "Dining chair")!;
    const newChair = changed.find((line) => line.name === "BERGMUND Chair")!;
    expect(oldChair.returnable).toBeNull();
    expect(newChair).toBeDefined();
    expect(newChair.itemId).not.toBe(oldChair.itemId);
    expect(changed.find((line) => line.name === "Writing desk")?.itemId).toBe(baseline.find((line) => line.name === "Writing desk")?.itemId);
    expect(issued.order.lines).toHaveLength(6);
    expect(issued.order.baselineLines.find((line) => line.itemId === CHAIR)?.name).toBe("Dining chair");
  });

  it("rolls back baseline import, revision creation and approvals if the final order insert fails", async () => {
    const { workspace } = await seed();
    const saved = await saveReady(workspace);
    const doomed = await store.saveReview(sessionId, "maple", { sourceDraftId: saved.review!.sourceDraftId, sourceDraftRevision: 1, expectedVersion: 1, input: { ...saved.review!.input, reviewNotes: "Reject this test order" } });
    await handle.db.execute(sql`CREATE FUNCTION pricing_test_reject_issue() RETURNS trigger AS $$ BEGIN IF NEW.document->>'reviewNotes' = 'Reject this test order' THEN RAISE EXCEPTION 'Intentional test insert failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await handle.db.execute(sql`CREATE TRIGGER pricing_test_reject_issue BEFORE INSERT ON change_orders FOR EACH ROW EXECUTE FUNCTION pricing_test_reject_issue()`);
    try {
      await expect(issue(doomed)).rejects.toThrow();
      expect(await handle.db.select().from(projects)).toHaveLength(0);
      expect(await handle.db.select().from(revisions)).toHaveLength(0);
      expect(await handle.db.select().from(approvals)).toHaveLength(0);
      expect(await handle.db.select().from(pricingCases)).toHaveLength(0);
      expect(await handle.db.select().from(changeOrders)).toHaveLength(0);
      expect((await store.getWorkspace(sessionId, "maple")).review?.version).toBe(2);
    } finally {
      await handle.db.execute(sql`DROP TRIGGER IF EXISTS pricing_test_reject_issue ON change_orders`);
      await handle.db.execute(sql`DROP FUNCTION IF EXISTS pricing_test_reject_issue()`);
    }
  });
});
