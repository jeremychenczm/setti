import { describe, expect, it, vi } from "vitest";
import type { ChangeModelOutput } from "../ai/model";
import type { MoneyContext } from "../ai/money-types";
import { runQuoteQuery, type QuoteQuery } from "../ai/quote-query";
import { approvedForTest } from "../opening/testing";
import { runCaseAi, type DraftDependencies } from "./service";
import type { CaseMessage, ChatStore, StoredCase } from "./types";

function human(id: string, text: string): CaseMessage {
  return { id, actor: "designer", text, createdAt: "2026-11-07T12:00:00Z", replyToMessageId: null, aiState: "none", error: null, model: null };
}

const overThousand: QuoteQuery = { filters: [{ field: "lineTotal", op: "gt", value: "1000" }], sort: { field: "lineTotal", direction: "desc" }, limit: null };

function lookup(query: QuoteQuery = overThousand, message = "Here are the lines whose total, including tax and delivery, is over $1,000."): ChangeModelOutput {
  return { intent: "quote", message, title: "Quote lookup", changes: [], unresolved: [], constraints: [], money: null, quoteQuery: query };
}

function scenario(text = "@Setti Which items are over $1000?", withMoneyRecords = false) {
  const quote = structuredClone(approvedForTest("willow"));
  const state: StoredCase = { id: "owned-case", projectKey: "willow", quote, draft: null, activeMessageId: "request", messages: [human("request", text)] };
  const context: MoneyContext = {
    projectKey: "willow", quoteId: quote.id, version: quote.version, checkedAt: "2026-11-07T12:10:00Z", providerRecordedAt: null, mode: "recorded_sandbox",
    facts: [{ id: "budget", text: { en: "The approved budget is not a payment receipt." }, sourceIds: ["quote"] }],
    sources: [{ id: "quote", kind: "quote", label: "Approved quote", href: "/quotes/willow", recordedAt: quote.approvedAt }],
  };
  const store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn(), getQuote: vi.fn(),
    beginAi: vi.fn().mockResolvedValue({ status: "started", runId: "run", state }),
    completeAi: vi.fn<ChatStore["completeAi"]>().mockResolvedValue(state), failAi: vi.fn().mockResolvedValue(state),
    readMoneyContext: vi.fn<NonNullable<ChatStore["readMoneyContext"]>>().mockResolvedValue(withMoneyRecords ? context : null!),
  } satisfies ChatStore;
  const deps = { configured: () => true, readPage: vi.fn<DraftDependencies["readPage"]>(), callModel: vi.fn<DraftDependencies["callModel"]>().mockResolvedValue({ output: lookup(), model: "test-model" }) };
  return { quote, state, store, deps };
}

const saved = (store: ReturnType<typeof scenario>["store"]) => store.completeAi.mock.calls[0][4];

describe("looking up lines in the approved quote from the chat", () => {
  it("saves the model's sentence with the lines the server found in the approved quote", async () => {
    const s = scenario();
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledOnce();
    const expected = runQuoteQuery(s.quote, overThousand);
    expect(expected.matchedCount).toBeGreaterThan(0);
    expect(saved(s.store)).toMatchObject({
      text: "Here are the lines whose total, including tax and delivery, is over $1,000.", model: "test-model",
      quoteAnswer: { quoteId: s.quote.id, version: s.quote.version, rows: expected.rows, matchedCount: expected.matchedCount, totalCents: expected.totalCents },
    });
  });

  it("answers a cost question as a lookup even when payment records exist", async () => {
    const s = scenario("@Setti What does the most expensive item cost?", true);
    s.deps.callModel.mockResolvedValue({ output: lookup({ filters: [], sort: { field: "lineTotal", direction: "desc" }, limit: 1 }, "Here is the line with the highest total, including tax and delivery."), model: "test-model" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(saved(s.store).quoteAnswer?.rows).toHaveLength(1);
    expect(saved(s.store).quoteAnswer?.matchedCount).toBe(s.quote.lines.length);
  });

  it("sends a query the server cannot run back once, with what to fix", async () => {
    const s = scenario();
    s.deps.callModel
      .mockResolvedValueOnce({ output: lookup({ ...overThousand, filters: [{ field: "name", op: "gt", value: "sofa" }] }), model: "test-model" })
      .mockResolvedValueOnce({ output: lookup(), model: "test-model" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledTimes(2);
    expect(s.deps.callModel.mock.calls[1][0].previousAttemptProblems?.join(" ")).toMatch(/text fields take only eq or contains/);
    expect(saved(s.store).quoteAnswer?.matchedCount).toBeGreaterThan(0);
  });

  it("shows only the computed lines, as a system notice, when the sentence states results twice", async () => {
    const s = scenario();
    s.deps.callModel.mockResolvedValue({ output: lookup(overThousand, "Three lines are over $1,000, led by one at $2,400."), model: "test-model" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledTimes(2);
    expect(saved(s.store)).toMatchObject({ model: "system", text: expect.stringMatching(/did not pass verification/), quoteAnswer: { matchedCount: runQuoteQuery(s.quote, overThousand).matchedCount } });
  });

  it("still drafts changes when the model returns an empty quoteQuery, as it always does outside quote mode", async () => {
    const s = scenario("@Setti Change the dining chairs to six.");
    const draft: ChangeModelOutput = {
      intent: "draft", message: "Quantity draft for designer review.", title: "Dining chair quantity", unresolved: [], constraints: [], money: null, quoteQuery: null,
      changes: [{ action: "quantity", itemId: "willow-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: ["request"] }],
    };
    s.deps.callModel.mockResolvedValue({ output: draft, model: "test-model" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledOnce();
    expect(saved(s.store).draft?.changes).toHaveLength(1);
  });

  it("refuses a query attached to any other kind of reply", async () => {
    const s = scenario("@Setti What should we confirm next?");
    const answer: ChangeModelOutput = { intent: "answer", message: "Confirm the dining chair fabric next.", title: "Next step", changes: [], unresolved: [], constraints: [], money: null, quoteQuery: overThousand };
    s.deps.callModel.mockResolvedValueOnce({ output: answer, model: "test-model" }).mockResolvedValueOnce({ output: { ...answer, quoteQuery: null }, model: "test-model" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel.mock.calls[1][0].previousAttemptProblems).toContain("Set quoteQuery=null unless intent is quote.");
    expect(saved(s.store)).toMatchObject({ text: "Confirm the dining chair fabric next." });
    expect(saved(s.store).quoteAnswer).toBeUndefined();
  });
});
