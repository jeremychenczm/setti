import { describe, expect, it, vi } from "vitest";
import type { ChangeModelOutput } from "@/ai/model";
import type { MoneyContext } from "@/ai/money-types";
import { HOME_EVIDENCE_ID, HOME_PRODUCT_IDS } from "@/demo/home-evidence";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_SUPPLIER_NOTES } from "@/demo/living-dining";
import { createPricingInput, previewPricing } from "@/pricing/calculation";
import { preapprovedQuote } from "./cases";
import { runCaseAi, type DraftDependencies } from "./service";
import type { CaseMessage, ChatStore, StoredCase } from "./types";

const at = "2026-10-29T12:00:00Z";
function fixture(actor: "designer" | "client" = "designer", text = HOME_DESIGNER_REQUEST) {
  const quote = structuredClone(HOME_APPROVED_QUOTE);
  const messages: CaseMessage[] = [...HOME_DISCUSSION, { actor: "designer" as const, text: HOME_SUPPLIER_NOTES }, { actor, text }].map((entry, index) => ({
    ...entry, id: index === HOME_DISCUSSION.length + 1 ? "request" : `discussion-${index}`,
    createdAt: at, replyToMessageId: null, aiState: "none", error: null, model: null,
  }));
  const state: StoredCase = { id: "home-case", projectKey: "maple", quote, messages, draft: null, activeMessageId: "request" };
  const context: MoneyContext = {
    projectKey: "maple", quoteId: quote.id, version: quote.version, checkedAt: at, providerRecordedAt: null, mode: "recorded_sandbox",
    facts: [{ id: "approval", text: { en: "Quote approval does not establish any payment result." }, sourceIds: ["quote"] }],
    sources: [{ id: "quote", kind: "quote", label: "Current quote", href: "/quotes/maple", recordedAt: at }],
  };
  const store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn(), getQuote: vi.fn(),
    beginAi: vi.fn().mockResolvedValue({ status: "started", runId: "run", state }),
    completeAi: vi.fn<ChatStore["completeAi"]>().mockResolvedValue(state), failAi: vi.fn().mockResolvedValue(state),
    readMoneyContext: vi.fn().mockResolvedValue(context),
  } satisfies ChatStore;
  const output: ChangeModelOutput = {
    intent: "draft", message: "Proposed changes for review.", title: "Living and dining revision", money: null,
    changes: [
      { action: "replace", itemId: "sofa", quantity: 1, productOptionId: HOME_PRODUCT_IDS.sofa, description: "Compact sofa", sourceMessageIds: ["discussion-4"] },
      { action: "replace", itemId: "coffee-table", quantity: 2, productOptionId: HOME_PRODUCT_IDS["coffee-table"], description: "Two side tables", sourceMessageIds: ["discussion-6"] },
      { action: "replace", itemId: "dining-table", quantity: 1, productOptionId: HOME_PRODUCT_IDS["dining-table"], description: "Round table", sourceMessageIds: ["discussion-10"] },
      { action: "quantity", itemId: "dining-chairs", quantity: 4, productOptionId: null, description: "", sourceMessageIds: ["discussion-12"] },
      { action: "remove", itemId: "sideboard", quantity: null, productOptionId: null, description: "", sourceMessageIds: ["discussion-14"] },
    ], unresolved: [], constraints: ["Keep design services unchanged."],
  };
  const deps = {
    configured: () => true, readPage: vi.fn<DraftDependencies["readPage"]>(),
    callModel: vi.fn<DraftDependencies["callModel"]>().mockResolvedValue({ output, model: "configured-model" }),
  };
  return { state, quote, store, context, output, deps };
}

describe("living-and-dining AI orchestration", () => {
  it("reads the complete discussion and supplied evidence, then prices all five changes against the approved V1", async () => {
    const s = fixture();
    await runCaseAi(s.store, "session", "maple", "request", s.deps);
    const input = s.deps.callModel.mock.calls[0][0];
    expect(input.messages).toEqual(s.state.messages);
    expect(input.messages).toHaveLength(HOME_DISCUSSION.length + 2);
    expect(input.quote).toEqual(s.quote);
    expect(input.pages).toHaveLength(1);
    expect(input.pages[0]).toMatchObject({ id: HOME_EVIDENCE_ID, text: HOME_SUPPLIER_NOTES });
    expect(s.deps.readPage).not.toHaveBeenCalled();
    const result = s.store.completeAi.mock.calls[0][4];
    expect(result.draft).toMatchObject({ basedOnQuoteId: s.quote.id, basedOnVersion: 1, origin: "designer", model: "configured-model" });
    expect(result.draft?.changes).toHaveLength(5);
    const pricing = createPricingInput(s.quote, result.draft!);
    expect(pricing.changes.every((change) => !change.confirmed)).toBe(true);
    expect(previewPricing(s.quote, result.draft!, pricing)).toMatchObject({ ready: false, proposedTotals: { totalCents: 567_000 }, deltaTotalCents: -206_000 });
    expect(s.store.failAi).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("moneyAnswer");
  });

  it.each(["draft", "cancel"] as const)("keeps a client's %s request from creating or withdrawing the studio proposal", async (intent) => {
    const s = fixture("client", intent === "draft" ? "@AI Prepare the revised quote from our discussion." : "@AI Cancel the current draft.");
    if (intent === "cancel") Object.assign(s.output, { intent, changes: [] });
    await runCaseAi(s.store, "session", "maple", "request", s.deps);
    const result = s.store.completeAi.mock.calls[0][4];
    expect(result).not.toHaveProperty("draft");
    expect(result).toMatchObject({ model: "system", text: expect.stringContaining("Jordan prepares") });
    expect(s.state.draft).toBeNull();
    expect(s.store.failAi).not.toHaveBeenCalled();
  });

  it("still lets the client ask read-only money questions without loading supplier products or editing a draft", async () => {
    const s = fixture("client", "@AI Explain the recorded payments and anything still pending.");
    Object.assign(s.output, { intent: "money", changes: [], money: { answer: { summary: { text: "The quote approval on its own does not show that any payment went through.", factIds: ["approval"] }, rows: [], notes: [] }, showEvidence: false } });
    await runCaseAi(s.store, "session", "maple", "request", s.deps);
    expect(s.deps.callModel).toHaveBeenCalledWith(expect.objectContaining({ pages: [], moneyContext: s.context }));
    const result = s.store.completeAi.mock.calls[0][4];
    expect(result).not.toHaveProperty("draft");
    expect(result.moneyAnswer?.facts.map((fact) => fact.id)).toEqual(["approval"]);
    expect(result.moneyAnswer?.facts[0].text.en).toBe("Quote approval does not establish any payment result.");
    expect(result.text).toBe("The quote approval on its own does not show that any payment went through.");
  });

  it("retains the existing client-initiated change flow for the legacy Maple story", async () => {
    const s = fixture("client", "@AI Increase the lounge chair quantity to two.");
    s.state.quote = preapprovedQuote("maple")!;
    s.state.messages = [s.state.messages.at(-1)!];
    s.context.quoteId = s.state.quote.id; s.context.version = s.state.quote.version;
    s.output.changes = [{ action: "quantity", itemId: "chair", quantity: 2, productOptionId: null, description: "", sourceMessageIds: ["request"] }];
    await runCaseAi(s.store, "session", "maple", "request", s.deps);
    expect(s.store.completeAi.mock.calls[0][4].draft).toMatchObject({ origin: "client", changes: [expect.objectContaining({ itemId: "chair", action: "quantity" })] });
    expect(s.deps.callModel.mock.calls[0][0].pages).toEqual([]);
  });
});
