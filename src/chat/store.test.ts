import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { studios } from "../auth/schema";
import { insertProject } from "../projects/store";
import { addTestProject, TEST_KEY } from "../projects/testing";
import { chatCases } from "./schema";
import { createChatStore } from "./store";
import { preapprovedQuote } from "./cases";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { AppendMessageInput, ChangeDraft, ChatStore } from "./types";
import { buildMoneyAnswer } from "../ai/money-answer";
import { runQuoteQuery } from "../ai/quote-query";

describe.skipIf(!testDatabaseUrl)("persisted demo chat", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let store: ChatStore;
  let sessionId: string;

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "chat_messages", "chat_cases");
    store = createChatStore(handle.db);
    sessionId = randomUUID();
    // A second project in the same studio, to show what stays with each project.
    await addTestProject(handle.db, sessionId);
  });
  afterAll(() => handle?.pool.end());

  function human(text = "@Setti Please help with this change."): AppendMessageInput {
    return { id: randomUUID(), actor: "client", text };
  }

  function draft(messageId: string, title = "Change draft"): ChangeDraft {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), projectKey: "maple", basedOnQuoteId: "demo-maple-v1", basedOnVersion: 1,
      basedOnQuoteFingerprint: quoteFingerprint(preapprovedQuote("maple")!),
      revision: 1, status: "needs_designer_review", title, summary: "A reviewable proposal; no payment.",
      changes: [], sourceMessageIds: [messageId], sources: [], unresolved: [], constraints: [],
      deltaSubtotalCents: 0, createdAt: now, updatedAt: now, model: "test-model",
    };
  }

  async function start(messageId: string) {
    const result = await store.beginAi(sessionId, "maple", messageId);
    if (result.status !== "started") throw new Error(`Expected started, got ${result.status}`);
    return result;
  }

  it("keeps the running reply's stage on the case only while that run is active", async () => {
    const input = human("@Setti explain the quote");
    await store.appendMessage(sessionId, "maple", input);
    const run = await start(input.id);
    expect((await store.getCase(sessionId, "maple")).activeRunStage).toBe("reading");
    await store.reportAiStage!(sessionId, "maple", run.runId, "checking");
    expect((await store.getCase(sessionId, "maple")).activeRunStage).toBe("checking");
    await store.reportAiStage!(sessionId, "maple", randomUUID(), "rewriting");
    expect((await store.getCase(sessionId, "maple")).activeRunStage).toBe("checking");
    await store.completeAi(sessionId, "maple", input.id, run.runId, { text: "Here is the quote.", model: "test-model" });
    expect((await store.getCase(sessionId, "maple")).activeRunStage).toBeNull();
    await store.reportAiStage!(sessionId, "maple", run.runId, "writing");
    expect((await store.getCase(sessionId, "maple")).activeRunStage).toBeNull();
  });

  it("lazily creates one case under concurrent reads and isolates sessions and projects", async () => {
    const [first, duplicate] = await Promise.all([store.getCase(sessionId, "maple"), store.getCase(sessionId, "maple")]);
    expect(first.id).toBe(duplicate.id);
    const message = human("Only this Maple session can see me.");
    await store.appendMessage(sessionId, "maple", message);
    expect((await store.getCase(sessionId, TEST_KEY)).messages).toEqual([]);
    expect((await store.getCase(randomUUID(), "maple")).messages).toEqual([]);
    expect((await store.getCase(sessionId, "maple")).messages[0].id).toBe(message.id);
    expect((await store.getCase(sessionId, "maple")).quote).toEqual(preapprovedQuote("maple")!);
    expect((await store.getCase(sessionId, TEST_KEY)).quote).toBeUndefined();
  });

  it("opens only a real studio's own projects, while a demo studio gets the samples on first use", async () => {
    const [real, demo] = [randomUUID(), randomUUID()];
    await handle.db.insert(studios).values([
      { id: real, name: "Lee Studio", slug: `real-${real}`, kind: "real", createdAt: new Date() },
      { id: demo, name: "Lee Studio", slug: `demo-${demo}`, kind: "demo", createdAt: new Date() },
    ]);
    for (const key of ["maple", TEST_KEY, "kitchen"]) await expect(store.getCase(real, key)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await handle.db.select().from(chatCases).where(eq(chatCases.sessionId, real))).toHaveLength(0);
    expect((await store.getCase(demo, "maple")).opening?.status).toBe("approved");
    await expect(store.getCase(demo, "kitchen")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // A project the studio created is read by its settings, whatever its name.
    await insertProject(handle.db, real, "kitchen", { name: "Kitchen", subtitle: "", startsFrom: "approved_quote", quote: preapprovedQuote("maple")! });
    expect((await store.getCase(real, "kitchen")).opening?.status).toBe("approved");
    await handle.db.delete(studios).where(eq(studios.id, real));
    await handle.db.delete(studios).where(eq(studios.id, demo));
  });

  it("rejects an AI result bound to another baseline without saving its draft or reply", async () => {
    const input = human();
    await store.appendMessage(sessionId, "maple", input);
    const run = await start(input.id);
    const stale = { ...draft(input.id), basedOnQuoteId: randomUUID(), basedOnVersion: 3 };
    await expect(store.completeAi(sessionId, "maple", input.id, run.runId, { text: "Stale result", draft: stale, model: "test-model" })).rejects.toMatchObject({ code: "STALE_BASELINE" });
    const state = await store.getCase(sessionId, "maple");
    expect(state.draft).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].aiState).toBe("running");
    // The orchestration layer can recover this failure through its normal run-bound failure path.
    await store.failAi(sessionId, "maple", input.id, run.runId, "The approved baseline changed.");
    expect((await store.getCase(sessionId, "maple")).activeMessageId).toBeNull();
  });

  it("persists a recorded money snapshot across reloads and retries without changing an existing draft", async () => {
    const first = human();
    await store.appendMessage(sessionId, "maple", first);
    const firstRun = await start(first.id);
    const existing = draft(first.id);
    await store.completeAi(sessionId, "maple", first.id, firstRun.runId, { text: "Review draft", draft: existing, model: "test-model" });
    const question = human("@Setti Explain this project's recorded payments.");
    await store.appendMessage(sessionId, "maple", question);
    const run = await start(question.id);
    const context = await store.readMoneyContext!(sessionId, "maple");
    const answer = buildMoneyAnswer(context, ["quote"]);
    const expected = structuredClone(answer.moneyAnswer);
    const result = { ...answer, model: "test-model" };
    await store.completeAi(sessionId, "maple", question.id, run.runId, result);
    answer.moneyAnswer.facts[0].text.en = "Later records must not rewrite the stored answer";
    await store.completeAi(sessionId, "maple", question.id, run.runId, result);
    const reloaded = await createChatStore(handle.db).getCase(sessionId, "maple");
    expect(reloaded.draft).toEqual({ ...existing, replyMessageId: expect.any(String) });
    expect(reloaded.messages.filter((m) => m.replyToMessageId === question.id)).toHaveLength(1);
    expect(reloaded.messages.find((m) => m.replyToMessageId === question.id)?.moneyAnswer).toEqual(expected);
    expect((await store.getCase(randomUUID(), "maple")).messages).toEqual([]);
  });

  it("rejects money answers for a stale approved version and never couples them to draft writes", async () => {
    const question = human("@Setti Explain my payments.");
    await store.appendMessage(sessionId, "maple", question);
    const run = await start(question.id);
    const context = await store.readMoneyContext!(sessionId, "maple");
    const answer = buildMoneyAnswer(context, ["quote"]);
    await expect(store.completeAi(sessionId, "maple", question.id, run.runId, { ...answer, moneyAnswer: { ...answer.moneyAnswer, quoteId: randomUUID(), version: 9 }, model: "test-model" })).rejects.toMatchObject({ code: "STALE_BASELINE" });
    await expect(store.completeAi(sessionId, "maple", question.id, run.runId, { ...answer, draft: null, model: "test-model" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await store.getCase(sessionId, "maple")).messages).toHaveLength(1);
  });

  it("stores a quote lookup's lines with the reply and refuses one computed on another version", async () => {
    const question = human("@Setti Which items are over $500?");
    await store.appendMessage(sessionId, "maple", question);
    const run = await start(question.id);
    const quoteAnswer = runQuoteQuery(preapprovedQuote("maple")!, { filters: [{ field: "lineTotal", op: "gt", value: "500" }], sort: null, limit: null });
    await expect(store.completeAi(sessionId, "maple", question.id, run.runId, { text: "Lines over $500.", quoteAnswer: { ...quoteAnswer, version: 9 }, model: "test-model" })).rejects.toMatchObject({ code: "STALE_BASELINE" });
    await expect(store.completeAi(sessionId, "maple", question.id, run.runId, { text: "Lines over $500.", quoteAnswer, draft: null, model: "test-model" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await store.completeAi(sessionId, "maple", question.id, run.runId, { text: "Lines over $500.", quoteAnswer, model: "test-model" });
    const reply = (await createChatStore(handle.db).getCase(sessionId, "maple")).messages.find((m) => m.replyToMessageId === question.id);
    expect(reply).toMatchObject({ text: "Lines over $500.", moneyAnswer: null, quoteAnswer });
    expect(reply?.quoteAnswer?.rows.map((row) => row.itemId)).toEqual(["chair"]);
  });

  it("requires the full baseline fingerprint on newly completed AI drafts", async () => {
    const input = human();
    await store.appendMessage(sessionId, "maple", input);
    const run = await start(input.id);
    const missing = draft(input.id);
    delete missing.basedOnQuoteFingerprint;
    await expect(store.completeAi(sessionId, "maple", input.id, run.runId, { text: "Unverified baseline", draft: missing, model: "test-model" })).rejects.toMatchObject({ code: "STALE_BASELINE" });
    await expect(store.completeAi(sessionId, "maple", input.id, run.runId, { text: "Mismatched contents", draft: { ...draft(input.id), basedOnQuoteFingerprint: "different contents" }, model: "test-model" })).rejects.toMatchObject({ code: "STALE_BASELINE" });
    expect((await store.getCase(sessionId, "maple")).draft).toBeNull();
  });

  it("deduplicates a client UUID, rejects changed content and permits that UUID in another case", async () => {
    const input = human("A regular message, without a model call.");
    const [first, duplicate] = await Promise.all([
      store.appendMessage(sessionId, "maple", input), store.appendMessage(sessionId, "maple", input),
    ]);
    expect(first.messages).toHaveLength(1);
    expect(duplicate.messages).toHaveLength(1);
    await expect(store.appendMessage(sessionId, "maple", { ...input, text: "Changed content" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await store.appendMessage(sessionId, TEST_KEY, input)).messages).toHaveLength(1);
  });

  it("requires an AI mention on a human message belonging to this exact case", async () => {
    const input = human("We like the original chair.");
    await store.appendMessage(sessionId, "maple", input);
    await expect(store.beginAi(sessionId, "maple", input.id)).rejects.toMatchObject({ code: "INVALID_AI_TRIGGER" });
    await expect(store.beginAi(sessionId, TEST_KEY, input.id)).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    await expect(store.beginAi(randomUUID(), "maple", input.id)).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect((await store.getCase(sessionId, "maple")).messages[0].aiState).toBe("none");
  });

  it("allows only one active run and one assistant reply, including duplicate sends and completions", async () => {
    const input = human();
    await store.appendMessage(sessionId, "maple", input);
    const results = await Promise.all([store.beginAi(sessionId, "maple", input.id), store.beginAi(sessionId, "maple", input.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(["busy", "started"]);
    const started = results.find((result) => result.status === "started")!;
    if (started.status !== "started") throw new Error("Missing active run");
    await expect(store.appendMessage(sessionId, "maple", human("Another message"))).rejects.toMatchObject({ code: "CASE_BUSY" });
    expect((await store.appendMessage(sessionId, "maple", input)).messages).toHaveLength(1);
    const result = { text: "Here is a proposal.", draft: draft(input.id), model: "test-model" };
    await store.completeAi(sessionId, "maple", input.id, started.runId, result);
    const repeated = await store.completeAi(sessionId, "maple", input.id, started.runId, result);
    expect(repeated.messages.filter((message) => message.actor === "assistant")).toHaveLength(1);
    expect(repeated.messages[0].aiState).toBe("completed");
    expect(repeated.activeMessageId).toBeNull();
    expect((await store.beginAi(sessionId, "maple", input.id)).status).toBe("completed");
  });

  it("persists the reply, completed trigger and draft together across a new store instance", async () => {
    const input = human();
    await store.appendMessage(sessionId, "maple", input);
    const run = await start(input.id);
    const proposal = draft(input.id);
    await store.completeAi(sessionId, "maple", input.id, run.runId, { text: "Please review this draft.", draft: proposal, model: "test-model" });
    const refreshed = await createChatStore(handle.db).getCase(sessionId, "maple");
    // The draft names the reply that brought it, which carries its card in the chat.
    expect(refreshed.draft).toEqual({ ...proposal, replyMessageId: refreshed.messages[1].id });
    expect(refreshed.messages).toHaveLength(2);
    expect(refreshed.messages[0]).toMatchObject({ id: input.id, aiState: "completed", error: null, model: "test-model" });
    expect(refreshed.messages[1]).toMatchObject({ actor: "assistant", replyToMessageId: input.id, text: "Please review this draft." });
    expect(refreshed.activeMessageId).toBeNull();
  });

  it("preserves the previous draft on failure, and permits a retry that returns only text", async () => {
    const first = human();
    await store.appendMessage(sessionId, "maple", first);
    const initialRun = await start(first.id);
    const originalDraft = draft(first.id);
    await store.completeAi(sessionId, "maple", first.id, initialRun.runId, { text: "Initial draft.", draft: originalDraft, model: "test-model" });
    const second = human("@Setti Explain the current draft.");
    await store.appendMessage(sessionId, "maple", second);
    const failedRun = await start(second.id);
    const failed = await store.failAi(sessionId, "maple", second.id, failedRun.runId, "Provider temporarily unavailable");
    expect(failed.draft).toEqual({ ...originalDraft, replyMessageId: expect.any(String) });
    expect(failed.messages.find((message) => message.id === second.id)).toMatchObject({ aiState: "failed", error: "Provider temporarily unavailable" });
    const retry = await start(second.id);
    expect(retry.runId).not.toBe(failedRun.runId);
    const completed = await store.completeAi(sessionId, "maple", second.id, retry.runId, { text: "The current draft changes nothing yet.", model: "test-model" });
    expect(completed.draft).toEqual({ ...originalDraft, replyMessageId: failed.draft!.replyMessageId });
    expect(completed.messages.filter((message) => message.replyToMessageId === second.id)).toHaveLength(1);
  });

  it("recovers a 180-second lease and rejects a late result or failure from the old attempt", async () => {
    const input = human();
    const initial = await store.appendMessage(sessionId, "maple", input);
    const oldRun = await start(input.id);
    await handle.db.update(chatCases).set({ activeRunStartedAt: new Date(Date.now() - 181_000) }).where(eq(chatCases.id, initial.id));
    const recovered = await store.getCase(sessionId, "maple");
    expect(recovered.activeMessageId).toBeNull();
    expect(recovered.messages[0]).toMatchObject({ aiState: "failed", error: "AI reply timed out. Retry this message." });
    const retry = await start(input.id);
    await expect(store.completeAi(sessionId, "maple", input.id, oldRun.runId, { text: "Late draft", draft: draft(input.id, "Stale"), model: "test-model" })).rejects.toMatchObject({ code: "STALE_AI_RUN" });
    await expect(store.failAi(sessionId, "maple", input.id, oldRun.runId, "Late failure")).rejects.toMatchObject({ code: "STALE_AI_RUN" });
    const current = await store.getCase(sessionId, "maple");
    expect(current.activeMessageId).toBe(input.id);
    expect(current.messages[0].aiState).toBe("running");
    expect(current.draft).toBeNull();
    const freshDraft = draft(input.id, "Fresh");
    const finished = await store.completeAi(sessionId, "maple", input.id, retry.runId, { text: "Fresh response", draft: freshDraft, model: "test-model" });
    expect(finished.draft?.title).toBe("Fresh");
  });

  it("marks a blocked AI trigger failed while leaving the active trigger intact", async () => {
    const first = human();
    const second = human("@Setti And could you explain the delivery cost?");
    await store.appendMessage(sessionId, "maple", first);
    await store.appendMessage(sessionId, "maple", second);
    const run = await start(second.id);
    const busy = await store.beginAi(sessionId, "maple", first.id);
    expect(busy.status).toBe("busy");
    expect(busy.state.messages.find((message) => message.id === second.id)?.aiState).toBe("running");
    expect(busy.state.messages.find((message) => message.id === first.id)?.aiState).toBe("failed");
    await store.completeAi(sessionId, "maple", second.id, run.runId, { text: "Current reply", model: "test-model" });
    await expect(store.beginAi(sessionId, "maple", first.id)).rejects.toMatchObject({ code: "STALE_MESSAGE" });
  });

  it("does not let retrying an old failed message overwrite a newer completed draft", async () => {
    const older = human();
    await store.appendMessage(sessionId, "maple", older);
    const oldRun = await start(older.id);
    await store.failAi(sessionId, "maple", older.id, oldRun.runId, "An earlier error");
    const newer = human("@Setti Use this updated direction instead.");
    await store.appendMessage(sessionId, "maple", newer);
    const newRun = await start(newer.id);
    const currentDraft = draft(newer.id, "New direction");
    await store.completeAi(sessionId, "maple", newer.id, newRun.runId, { text: "Updated draft", draft: currentDraft, model: "test-model" });
    await expect(store.beginAi(sessionId, "maple", older.id)).rejects.toMatchObject({ code: "STALE_MESSAGE" });
    expect((await store.getCase(sessionId, "maple")).draft).toEqual({ ...currentDraft, replyMessageId: expect.any(String) });
  });

  it("uses the shared invocation syntax for natural @Setti commands", async () => {
    const input = human("@Setti: set the quantity to 4");
    await store.appendMessage(sessionId, "maple", input);
    const run = await start(input.id);
    await store.completeAi(sessionId, "maple", input.id, run.runId, { text: "The quantity proposal is ready.", model: "test-model" });
    const incidentalMention = human("The previous note mentioned @Setti, but this is not a command.");
    await store.appendMessage(sessionId, "maple", incidentalMention);
    await expect(store.beginAi(sessionId, "maple", incidentalMention.id)).rejects.toMatchObject({ code: "INVALID_AI_TRIGGER" });
    // A completed original request remains idempotent even after a later human message.
    expect((await store.beginAi(sessionId, "maple", input.id)).status).toBe("completed");
    const next = human("@Setti set the quantity to 6");
    await store.appendMessage(sessionId, "maple", next);
    expect((await store.beginAi(sessionId, "maple", next.id)).status).toBe("started");
  });

  it("rejects an old failed trigger after a newer ordinary human correction", async () => {
    const trigger = human("@Setti Change the chair quantity to 6.");
    await store.appendMessage(sessionId, "maple", trigger);
    const run = await start(trigger.id);
    await store.failAi(sessionId, "maple", trigger.id, run.runId, "Temporary provider failure");
    const correction = human("Actually, make it 4 chairs.");
    await store.appendMessage(sessionId, "maple", correction);
    await expect(store.beginAi(sessionId, "maple", trigger.id)).rejects.toMatchObject({ code: "STALE_MESSAGE" });
    const current = await store.getCase(sessionId, "maple");
    expect(current.activeMessageId).toBeNull();
    expect(current.messages).toHaveLength(2);
    expect(current.messages.every((message) => message.actor !== "assistant")).toBe(true);
    expect(current.messages[0].aiState).toBe("failed");
  });

  it("clears an unapproved draft only when an AI result explicitly supplies null", async () => {
    const initial = human();
    await store.appendMessage(sessionId, "maple", initial);
    const firstRun = await start(initial.id);
    await store.completeAi(sessionId, "maple", initial.id, firstRun.runId, { text: "Draft ready.", draft: draft(initial.id), model: "test-model" });
    const cancel = human("@Setti Discard the unapproved draft and keep the original quote.");
    await store.appendMessage(sessionId, "maple", cancel);
    const cancelRun = await start(cancel.id);
    const cleared = await store.completeAi(sessionId, "maple", cancel.id, cancelRun.runId, { text: "The unapproved draft was discarded. No order or payment was changed.", draft: null, model: "test-model" });
    expect(cleared.draft).toBeNull();
    expect(cleared.activeMessageId).toBeNull();
    expect((await createChatStore(handle.db).getCase(sessionId, "maple")).draft).toBeNull();
    expect(cleared.messages.find((message) => message.id === cancel.id)?.aiState).toBe("completed");
  });
});
