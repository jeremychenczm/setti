import { describe, expect, it, vi } from "vitest";
import type { ChatStore, StoredCase } from "./types";
import { messageUrls, runCaseAi } from "./service";
import { defaultOpening } from "../opening/document";
import { approvedForTest } from "../opening/testing";
import { quoteFingerprint } from "../quotes/fingerprint";

function scenario(text = "@AI，餐椅从四把改成六把。") {
  const state: StoredCase = {
    id: "case-test", projectKey: "willow", draft: null, activeMessageId: "request", quote: approvedForTest("willow"),
    messages: [{ id: "request", actor: "client", text, createdAt: "2026-10-18T12:00:00Z", replyToMessageId: null, aiState: "running", error: null, model: null }],
  };
  const store: ChatStore = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn(), getQuote: vi.fn(),
    beginAi: vi.fn().mockResolvedValue({ status: "started", runId: "run", state }),
    completeAi: vi.fn().mockResolvedValue(state), failAi: vi.fn().mockResolvedValue(state),
  };
  const modelOutput = { intent: "draft" as const, message: "待核价数量草稿。", title: "餐椅数量", changes: [{ action: "quantity" as const, itemId: "willow-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: ["request"] }], unresolved: [], constraints: [] };
  const deps = { configured: () => true, readPage: vi.fn(), callModel: vi.fn().mockResolvedValue({ model: "test-model", output: modelOutput }) };
  return { state, store, deps, modelOutput };
}

describe("AI orchestration", () => {
  it("answers without a model or draft until the client has an approved V1", async () => {
    for (const status of ["draft", "sent"] as const) {
      const s = scenario();
      s.state.opening = { ...defaultOpening("willow"), status };
      await runCaseAi(s.store, "session", "willow", "request", s.deps);
      expect(s.deps.callModel).not.toHaveBeenCalled();
      expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", { text: expect.stringContaining("Quote V1"), model: "system" });
    }
  });
  it("handles a bare mention without calling a model or requiring a key", async () => {
    const s = scenario("@AI");
    await runCaseAi(s.store, "session", "willow", "request", { ...s.deps, configured: () => false });
    expect(s.deps.callModel).not.toHaveBeenCalled();
    expect(s.deps.readPage).not.toHaveBeenCalled();
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", expect.objectContaining({ model: "system" }));
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
    const s = scenario("@AI Increase the approved six chairs to eight.");
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
    const s = scenario("@AI，改成这个4把 https://shop.example/chair。 https://shop.example/chair");
    s.deps.readPage.mockRejectedValue(new Error("页面要求登录"));
    Object.assign(s.modelOutput.changes[0], { action: "replace", productOptionId: null, quantity: 4, description: "新餐椅" });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.readPage).toHaveBeenCalledTimes(1);
    expect(s.deps.callModel.mock.calls[0][0].pages[0]).toMatchObject({ error: "页面要求登录", products: [] });
    expect(s.store.completeAi).toHaveBeenCalledWith("session", "willow", "request", "run", expect.objectContaining({ draft: expect.objectContaining({ deltaSubtotalCents: null }) }));
  });
  it("marks invalid model output failed without persisting a draft", async () => {
    const s = scenario();
    s.modelOutput.changes[0].itemId = "foreign-item";
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
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
    expect(messageUrls("看这个 https://shop.example/item?variant=gray&currency=USD，其他不动。")).toEqual(["https://shop.example/item?variant=gray&currency=USD"]);
  });
});
