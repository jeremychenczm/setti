import { describe, expect, it, vi } from "vitest";
import type { ChatStore, StoredCase } from "./types";
import { messageUrls, runCaseAi } from "./service";
import { defaultOpening } from "../opening/document";
import { approvedForTest } from "../opening/testing";
import { quoteFingerprint } from "../quotes/fingerprint";

function scenario(text = "@Setti Change the dining chairs from four to six.") {
  const state: StoredCase = {
    id: "case-test", projectKey: "willow", draft: null, activeMessageId: "request", quote: approvedForTest("willow"),
    messages: [{ id: "request", actor: "client", text, createdAt: "2026-10-18T12:00:00Z", replyToMessageId: null, aiState: "running", error: null, model: null }],
  };
  const store: ChatStore = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn(), getQuote: vi.fn(),
    beginAi: vi.fn().mockResolvedValue({ status: "started", runId: "run", state }),
    completeAi: vi.fn().mockResolvedValue(state), failAi: vi.fn().mockResolvedValue(state),
  };
  const modelOutput = { intent: "draft" as const, message: "Quantity draft for designer review.", title: "Dining chair quantity", changes: [{ action: "quantity" as const, itemId: "willow-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: ["request"] }], unresolved: [], constraints: [] };
  const deps = { configured: () => true, readPage: vi.fn(), callModel: vi.fn().mockResolvedValue({ model: "test-model", output: modelOutput }) };
  return { state, store, deps, modelOutput };
}

describe("AI orchestration", () => {
  it("lets Setti answer, without a quote to draft against, until the client approves V1", async () => {
    for (const status of ["draft", "sent"] as const) {
      const s = scenario();
      s.state.opening = { ...defaultOpening("willow"), status };
      const answer = { ...s.modelOutput, intent: "answer" as const, message: "Quote V1 is not approved yet, so there is nothing to change.", title: "", changes: [] };
      s.deps.callModel.mockResolvedValue({ model: "test-model", output: answer });
      await runCaseAi(s.store, "session", "willow", "request", s.deps);
      expect(s.deps.callModel).toHaveBeenCalledWith(expect.objectContaining({ quote: null, openingStatus: status, moneyContext: null, pages: [] }));
      expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", { text: answer.message, model: "test-model" });
    }
  });
  it("does not save a draft before V1 is approved, even if the model returns one twice", async () => {
    const s = scenario();
    s.state.opening = { ...defaultOpening("willow"), status: "sent" };
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("did not pass verification");
    expect(s.deps.callModel).toHaveBeenCalledTimes(2);
    expect(s.deps.callModel.mock.calls[1][0].previousAttemptProblems.join(" ")).toContain("not approved yet");
    expect(s.store.completeAi).not.toHaveBeenCalled();
  });
  it("asks the model about a bare mention instead of answering with fixed text", async () => {
    const s = scenario("@Setti");
    const clarify = { ...s.modelOutput, intent: "clarify" as const, message: "Should I explain the quote or draft a change?", title: "", changes: [] };
    s.deps.callModel.mockResolvedValue({ model: "test-model", output: clarify });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledOnce();
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", { text: clarify.message, model: "test-model" });
  });
  it("saves a real failure rather than manufacturing a result when not configured", async () => {
    const s = scenario();
    await expect(runCaseAi(s.store, "session", "willow", "request", { ...s.deps, configured: () => false })).rejects.toThrow("is not configured");
    expect(s.store.failAi).toHaveBeenCalledOnce();
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.deps.callModel).not.toHaveBeenCalled();
  });
  it("builds a validated draft from the real model interface and server-owned quote", async () => {
    const s = scenario();
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledWith(expect.objectContaining({ triggerId: "request", quote: expect.objectContaining({ projectId: "willow" }) }));
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", expect.objectContaining({ model: "test-model", draft: expect.objectContaining({ status: "needs_designer_review", deltaSubtotalCents: 16000 }) }));
  });
  it("uses the latest customer-confirmed snapshot for the next round instead of returning to V1", async () => {
    const s = scenario("@Setti Increase the approved six chairs to eight.");
    const approved = structuredClone(approvedForTest("willow"));
    approved.id = "confirmed-willow-v3";
    approved.version = 3;
    const chair = approved.lines.find((line) => line.itemId === "willow-dining-chair")!;
    chair.quantity = 6;
    chair.unitPriceCents = 12_500;
    s.state.quote = approved;
    s.modelOutput.changes[0].quantity = 8;
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledWith(expect.objectContaining({ quote: approved }));
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", expect.objectContaining({
      draft: expect.objectContaining({ basedOnQuoteId: approved.id, basedOnVersion: 3, basedOnQuoteFingerprint: quoteFingerprint(approved), deltaSubtotalCents: 25_000 }),
    }));
  });
  it("deduplicates links, preserves failed retrieval and never invents a product", async () => {
    const s = scenario("@Setti Change to this one, 4 chairs https://shop.example/chair. https://shop.example/chair");
    s.deps.readPage.mockRejectedValue(new Error("The page requires sign-in"));
    Object.assign(s.modelOutput.changes[0], { action: "replace", productOptionId: null, quantity: 4, description: "New dining chair" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.readPage).toHaveBeenCalledTimes(1);
    expect(s.deps.callModel.mock.calls[0][0].pages[0]).toMatchObject({ error: "The page requires sign-in", products: [] });
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", expect.objectContaining({ draft: expect.objectContaining({ deltaSubtotalCents: null }) }));
  });
  it("reports each stage of a reply, including the corrected attempt", async () => {
    const s = scenario();
    const stages: string[] = [];
    s.store.reportAiStage = vi.fn(async (_session: string, _key: string, _run: string, stage: string) => { stages.push(stage); });
    s.modelOutput.changes[0].itemId = "foreign-item";
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("did not pass verification");
    expect(stages).toEqual(["writing", "checking", "rewriting", "checking"]);
  });
  it("marks invalid model output failed without persisting a draft", async () => {
    const s = scenario();
    s.modelOutput.changes[0].itemId = "foreign-item";
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("did not pass verification");
    expect(s.deps.callModel).toHaveBeenCalledTimes(2);
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.store.failAi).toHaveBeenCalledOnce();
  });
  it("does not run a second model call for a completed request", async () => {
    const s = scenario();
    vi.mocked(s.store.beginAi).mockResolvedValue({ status: "completed", state: s.state });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.callModel).not.toHaveBeenCalled();
  });
  it("does not leak upstream error details into saved errors", async () => {
    const s = scenario();
    s.deps.callModel.mockRejectedValue(new Error("upstream rejected api_key sk-ant-secret-example"));
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.not.toThrow("sk-ant");
    expect(JSON.stringify(vi.mocked(s.store.failAi).mock.calls)).not.toContain("sk-ant");
  });
  it("normalizes sentence punctuation without changing product URL query choices", () => {
    expect(messageUrls("Look at this https://shop.example/item?variant=gray&currency=USD, keep the rest.")).toEqual(["https://shop.example/item?variant=gray&currency=USD"]);
  });
});
