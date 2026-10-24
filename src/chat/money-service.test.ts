import { describe, expect, it, vi } from "vitest";
import { buildDraft } from "../ai/draft";
import { modelContext, type ChangeModelOutput } from "../ai/model";
import type { MoneyAnswer, MoneyContext } from "../ai/money-types";
import { approvedForTest } from "../opening/testing";
import { runCaseAi, type DraftDependencies } from "./service";
import type { CaseMessage, ChatStore, StoredCase } from "./types";

function human(id: string, text: string): CaseMessage {
  return { id, actor: "client", text, createdAt: "2026-10-21T12:00:00Z", replyToMessageId: null, aiState: "none", error: null, model: null };
}

function scenario(text = "@AI，为什么预算和付款金额不同？") {
  const quote = structuredClone(approvedForTest("willow"));
  const original = human("original", "@AI，餐椅改成六把。");
  const quantity: ChangeModelOutput = {
    intent: "draft", message: "数量草稿，待设计师核价。", title: "餐椅数量",
    changes: [{ action: "quantity", itemId: "willow-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: [original.id] }],
    unresolved: [], constraints: [],
  };
  const draft = buildDraft({ output: quantity, quote, messages: [original], pages: [], current: null, triggerId: original.id, model: "original-model" }).draft!;
  const state: StoredCase = { id: "owned-case", projectKey: "willow", quote, draft, activeMessageId: "request", messages: [original, human("request", text)] };
  const context: MoneyContext = {
    projectKey: "willow", quoteId: quote.id, version: quote.version,
    checkedAt: "2026-10-21T12:10:00Z", providerRecordedAt: "2026-10-21T12:09:00Z", mode: "recorded_sandbox",
    facts: [
      { id: "budget", text: { en: "The approved budget is not a payment receipt." }, sourceIds: ["quote"] },
      { id: "pending", text: { en: "A payment outcome is unknown; check the existing operation first." }, sourceIds: ["quote"] },
    ],
    sources: [{ id: "quote", kind: "quote", label: "Approved quote", href: "/quotes/willow", recordedAt: quote.approvedAt }],
    mandatoryFactIds: ["pending"],
  };
  const store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn(), getQuote: vi.fn(),
    beginAi: vi.fn().mockResolvedValue({ status: "started", runId: "run", state }),
    completeAi: vi.fn<ChatStore["completeAi"]>().mockResolvedValue(state), failAi: vi.fn().mockResolvedValue(state),
    readMoneyContext: vi.fn<NonNullable<ChatStore["readMoneyContext"]>>().mockResolvedValue(context),
  } satisfies ChatStore;
  const output: ChangeModelOutput = { intent: "money", message: "Untrusted model prose must not become a receipt.", title: "Money", changes: [], unresolved: [], constraints: [], money: { factIds: ["budget"] } };
  const deps = { configured: () => true, readPage: vi.fn<DraftDependencies["readPage"]>(), callModel: vi.fn<DraftDependencies["callModel"]>().mockResolvedValue({ output, model: "test-model" }) };
  return { state, store, context, output, deps, quantity };
}

describe("grounded money chat orchestration", () => {
  it("answers a financial question without fetching more than four historical product links", async () => {
    const s = scenario();
    s.state.messages.splice(1, 0, human("old-links", Array.from({ length: 5 }, (_, index) => `https://shop.example/${index}`).join(" ")));
    s.deps.readPage.mockRejectedValue(new Error("Old product links are unavailable"));
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.readPage).not.toHaveBeenCalled();
    expect(s.deps.callModel).toHaveBeenCalledWith(expect.objectContaining({ pages: [], moneyContext: s.context }));
    expect(s.store.completeAi).toHaveBeenCalledOnce();
  });

  it("stores trusted facts and mandatory uncertainty without changing the existing draft", async () => {
    const s = scenario();
    const previousDraft = structuredClone(s.state.draft);
    s.output.message = "I already refunded $999 and changed the order.";
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    const saved = s.store.completeAi.mock.calls[0][4];
    expect(saved).not.toHaveProperty("draft");
    expect(s.state.draft).toEqual(previousDraft);
    expect(saved.text).not.toContain("$999");
    expect(saved.moneyAnswer).toMatchObject({ quoteId: s.context.quoteId, checkedAt: s.context.checkedAt, providerRecordedAt: s.context.providerRecordedAt });
    expect(saved.moneyAnswer?.facts.map((fact) => fact.id)).toEqual(["budget", "pending"]);
    expect(saved.moneyAnswer?.sources).toEqual(s.context.sources);
    s.context.facts[0].text.en = "A later transaction changed the records";
    expect(saved.moneyAnswer?.facts[0].text.en).toBe("The approved budget is not a payment receipt.");
  });

  it.each([{ ids: ["foreign-fact"] }, { ids: [] }, { ids: ["budget", "budget"] }])("rejects invalid model-selected evidence $ids", async ({ ids }) => {
    const s = scenario();
    s.output.money = { factIds: ids };
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.store.failAi).toHaveBeenCalledOnce();
  });

  it("rejects a fact referencing an absent source", async () => {
    const s = scenario();
    s.context.facts[0].sourceIds = ["foreign-source"];
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
  });

  it.each(["answer", "draft", "cancel"] as const)("does not turn a money question into ungrounded %s output", async (intent) => {
    const s = scenario();
    Object.assign(s.output, { intent, message: "已经退款 $999。", money: null });
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.store.failAi).toHaveBeenCalledOnce();
  });

  it("allows a genuine clarification without touching the draft", async () => {
    const s = scenario();
    Object.assign(s.output, { intent: "clarify", message: "你想查看哪件物品的记录？", money: null });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.store.completeAi.mock.calls[0][4]).not.toHaveProperty("draft");
    expect(s.store.completeAi.mock.calls[0][4].text).toBe("你想查看哪件物品的记录？");
  });

  it("does not permit financial claims through clarification prose", async () => {
    const s = scenario();
    Object.assign(s.output, { intent: "clarify", message: "已经退款 $999。你还想问哪笔？", money: null });
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
  });

  it.each(["The rug was refunded.", "已经退款。", "Paid $999.", "The rug has not been refunded.", "The desk is not paid.", "地毯款项已退还。", "款项尚未收取。"])("blocks unsupported money claims in a generic answer: %s", async (message) => {
    const s = scenario("@AI What happened to this item?");
    Object.assign(s.output, { intent: "answer", message, money: null });
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
  });

  it("fails closed before calling a model if the money snapshot cannot be read", async () => {
    const s = scenario();
    s.store.readMoneyContext.mockRejectedValue(new Error("storage unavailable"));
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.deps.callModel).not.toHaveBeenCalled();
    expect(s.deps.readPage).not.toHaveBeenCalled();
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.store.failAi).toHaveBeenCalledOnce();
  });

  it.each(["quote", "version", "case"])("rejects a snapshot with %s drift before calling the model", async (drift) => {
    const s = scenario();
    if (drift === "quote") s.context.quoteId = "different-quote";
    if (drift === "version") s.context.version += 1;
    if (drift === "case") s.context.projectKey = "maple";
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("approved version for this project has changed");
    expect(s.deps.callModel).not.toHaveBeenCalled();
    expect(s.store.completeAi).not.toHaveBeenCalled();
  });

  it("preserves no-record uncertainty instead of inventing settled zero balances", async () => {
    const s = scenario();
    s.context.providerRecordedAt = null;
    s.context.facts[1] = { id: "missing", text: { en: "No recorded payment evidence is available; payment status is unknown." }, sourceIds: ["quote"] };
    s.context.mandatoryFactIds = ["missing"];
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    const saved = s.store.completeAi.mock.calls[0][4].moneyAnswer!;
    expect(saved.providerRecordedAt).toBeNull();
    expect(saved.facts.map((fact) => fact.id)).toContain("missing");
    expect(JSON.stringify(saved)).not.toMatch(/\$0|已支付|已付清|unpaid/);
  });

  it("omits prior reply evidence metadata from model history and supplies the fresh snapshot separately", () => {
    const s = scenario();
    const historical: MoneyAnswer = { ...structuredClone(s.context), quoteId: "historic-quote", facts: [{ id: "historical-only-fact", text: { en: "Historical marker" }, sourceIds: ["historic-source"] }], sources: [{ id: "historic-source", kind: "payment", label: "old-provider-only-marker", href: "/quotes/willow", recordedAt: "2026-10-20T00:00:00Z" }] };
    const previous: CaseMessage = { ...human("previous-reply", "An earlier money answer."), actor: "assistant", moneyAnswer: historical };
    const serialized = modelContext({ quote: s.state.quote!, messages: [previous, ...s.state.messages], pages: [], current: s.state.draft, triggerId: "request", moneyContext: s.context });
    const payload = JSON.parse(serialized);
    expect(payload.messages[0]).not.toHaveProperty("moneyAnswer");
    expect(serialized).not.toContain("historical-only-fact");
    expect(serialized).not.toContain("old-provider-only-marker");
    expect(payload.moneyEvidence).toEqual(s.context);
  });

  it("strips API money:null before normal draft validation", async () => {
    const s = scenario("@AI，餐椅从四把改成六把。");
    Object.assign(s.output, s.quantity, { money: null });
    s.output.changes[0].sourceMessageIds = ["request"];
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    const saved = s.store.completeAi.mock.calls[0][4];
    expect(saved.draft).toMatchObject({ status: "needs_designer_review" });
    expect(saved).not.toHaveProperty("moneyAnswer");
  });

  it.each([
    { request: "@AI Increase the dining chairs to six.", message: "I already refunded $999 and changed the order.", title: "Refunded $999" },
    { request: "@AI Increase the dining chairs to six.", message: "Your money has reached your wallet. The new order is confirmed.", title: "Chair quantity" },
    { request: "@AI，餐椅从四把改成六把。", message: "已经退款 $999。附言：书桌已扣款。", title: "退款已完成" },
  ])("replaces ungrounded draft prose in both the chat reply and saved summary: $message", async ({ request, message, title }) => {
    const s = scenario(request);
    Object.assign(s.output, s.quantity, { message, title, money: null });
    s.output.changes[0].sourceMessageIds = ["request"];
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    const saved = s.store.completeAi.mock.calls[0][4];
    expect(saved.draft).toMatchObject({ status: "needs_designer_review", revision: s.state.draft!.revision + 1 });
    expect(saved.draft?.summary).toBe(saved.text);
    expect(saved.text).not.toContain(message);
    expect(saved.text).not.toContain("999");
    expect(saved.text).not.toContain("has reached your wallet");
    expect(saved.text).toMatch(/designer review|待设计师核价/u);
    if (title !== "Chair quantity") expect(saved.draft?.title).toMatch(/Change draft for designer review|待核价变更草稿/u);
    else expect(saved.draft?.title).toBe(title);
    expect(s.store.failAi).not.toHaveBeenCalled();
    expect(saved).not.toHaveProperty("moneyAnswer");
  });

  it.each([
    { request: "@AI Decrease the dining chairs to two and plan the refund for review.", message: "Proposed goods difference: -$160; a $160 refund is planned after client approval, not issued." },
    { request: "@AI，餐椅减为两把，拟退款方案交给设计师核价。", message: "拟减少预算 $160，并在客户确认后申请退款，尚未执行。" },
  ])("keeps a legitimate amount and future refund proposal without accepting its prose as a receipt: $request", async ({ request, message }) => {
    const s = scenario(request);
    Object.assign(s.output, s.quantity, { message, money: null });
    s.output.changes[0].quantity = 2;
    s.output.changes[0].sourceMessageIds = ["request"];
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    const saved = s.store.completeAi.mock.calls[0][4];
    expect(saved.draft?.changes[0]).toMatchObject({ action: "quantity", after: { quantity: 2, unitPriceCents: 8_000 }, deltaSubtotalCents: -16_000 });
    expect(saved.draft?.deltaSubtotalCents).toBe(-16_000);
    expect(saved.draft?.summary).toBe(saved.text);
    expect(saved.text).toMatch(/refund plan need verification|拟退款方案仍需核实/u);
    expect(s.store.failAi).not.toHaveBeenCalled();
  });

  it.each(["answer", "clarify"] as const)("still rejects unsupported %s prose for a change request", async (intent) => {
    const s = scenario("@AI Increase the dining chairs to six.");
    Object.assign(s.output, { intent, message: "I refunded $999.", changes: [], money: null });
    await expect(runCaseAi(s.store, "session", "willow", "request", s.deps)).rejects.toThrow("result validation failed");
    expect(s.store.completeAi).not.toHaveBeenCalled();
    expect(s.store.failAi).toHaveBeenCalledOnce();
  });

  it("keeps a quantity change with a price question on the draft path", async () => {
    const s = scenario("@AI，餐椅从四把改成六把，看看多少钱。");
    Object.assign(s.output, s.quantity, { money: null });
    s.output.changes[0].sourceMessageIds = ["request"];
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.store.completeAi.mock.calls[0][4].draft?.changes[0]).toMatchObject({ action: "quantity", after: { quantity: 6 } });
    expect(s.store.failAi).not.toHaveBeenCalled();
  });

  it("fetches a replacement link and saves the draft when an explicit English change also asks cost", async () => {
    const s = scenario("@AI Can you replace the chair with this one and show the cost? https://shop.example/chair");
    Object.assign(s.output, {
      intent: "draft", message: "Replacement draft for designer review.", money: null,
      changes: [{ action: "replace", itemId: "willow-dining-chair", quantity: 4, productOptionId: "new-chair", description: "New chair", sourceMessageIds: ["request"] }],
    });
    s.deps.readPage.mockResolvedValue({ id: "chair-page", url: "https://shop.example/chair", fetchedAt: "2026-10-21T12:00:00Z", title: "New chair", text: "New oak chair", error: null, products: [{ id: "new-chair", name: "New oak chair", sku: "NEW-CHAIR", brand: "Example", seller: "Example shop", specification: "Oak", currency: "USD", unitPriceCents: 12_500, unitLabel: "each", priceEvidence: "USD 125", availability: "In stock" }] });
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.deps.readPage).toHaveBeenCalledExactlyOnceWith("https://shop.example/chair");
    expect(s.store.completeAi.mock.calls[0][4].draft?.changes[0]).toMatchObject({ action: "replace", after: { name: "New oak chair", quantity: 4, unitPriceCents: 12_500 } });
    expect(s.store.failAi).not.toHaveBeenCalled();
  });

  it("keeps an explanation of an earlier replacement read-only", async () => {
    const s = scenario("@AI Why did we replace the chair and pay more?");
    await runCaseAi(s.store, "session", "willow", "request", s.deps);
    expect(s.store.completeAi.mock.calls[0][4]).toHaveProperty("moneyAnswer");
    expect(s.store.completeAi.mock.calls[0][4]).not.toHaveProperty("draft");
    expect(s.deps.readPage).not.toHaveBeenCalled();
  });
});
