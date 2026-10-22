import { describe, expect, it } from "vitest";
import { buildMoneyAnswer, hasUnsupportedMoneyClaim, isMoneyQuestion } from "./money-answer";
import type { MoneyContext } from "./money-types";

function evidence(): MoneyContext {
  return {
    projectKey: "maple", quoteId: "demo-maple-v1", version: 1, checkedAt: "2026-10-21T20:00:00Z", providerRecordedAt: null, mode: "recorded_sandbox",
    sources: [{ id: "quote", kind: "quote", label: "Approved quote", href: "/quotes/maple", recordedAt: null }],
    facts: [
      { id: "budget", text: { en: "Budget changed by $60.", zh: "预算增加 $60。" }, sourceIds: ["quote"] },
      { id: "unknown", text: { en: "No recorded payment evidence.", zh: "没有已记录的付款依据。" }, sourceIds: ["quote"] },
    ], mandatoryFactIds: ["unknown"],
  };
}

describe("recorded money answers", () => {
  it("renders only server facts, always retains uncertainty, and snapshots their evidence", () => {
    const context = evidence();
    const result = buildMoneyAnswer(context, ["budget"], "@AI 为什么预算只增加60？");
    expect(result.moneyAnswer.facts.map((f) => f.id)).toEqual(["budget", "unknown"]);
    expect(result.moneyAnswer.sources).toEqual(context.sources);
    expect(result.text).toContain("保存");
    context.facts[0].text.zh = "Changed later";
    context.sources[0].label = "Changed later";
    expect(result.moneyAnswer.facts[0].text.zh).toBe("预算增加 $60。");
    expect(result.moneyAnswer.sources[0].label).toBe("Approved quote");
  });
  it.each([{ ids: [] }, { ids: ["foreign"] }, { ids: ["budget", "budget"] }])("rejects invalid fact selection $ids", ({ ids }) => {
    expect(() => buildMoneyAnswer(evidence(), ids, "Explain payments")).toThrow();
  });
  it("rejects invented citations and external source links", () => {
    const context = evidence();
    context.facts[0].sourceIds = ["fake"];
    expect(() => buildMoneyAnswer(context, ["budget"], "Explain payments")).toThrow();
    context.facts[0].sourceIds = ["quote"];
    context.sources[0].href = "https://evil.example/pay";
    expect(() => buildMoneyAnswer(context, ["budget"], "Explain payments")).toThrow();
  });
  it.each(["@AI 为什么书桌已扣款但地毯还没有退款？", "@AI Explain the holds and refunds.", "@AI Where is my money?", "@AI 核对这次预算和付款情况", "@AI Why did we replace the chair and pay more?", "@AI Please explain why replacing the chair cost more.", "@AI 请解释为什么把餐椅换成新款后预算变多了"])('recognizes a read-only money question: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(true);
  });
  it.each(["@AI 餐椅从四把改成六把，其他不动。", "@AI Return the rug and replace the chair with a desk.", "@AI 地毯退掉，书桌改两张", "@AI，餐椅从四把改成六把，看看多少钱。", "@AI Can you replace the chair and show the cost?", "@AI Could you please replace the chair and show the cost?", "@AI Please replace the chair and show the cost."])('keeps natural change requests on the draft path: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(false);
  });
  it.each(["You already paid $999.", "The refund completed.", "已经退款成功了。", "书桌已扣款。", "授权结果未知。", "The rug has not been refunded.", "The desk is not paid.", "地毯款项已退还。", "款项尚未收取。", "Payment has not been received."])("blocks unsupported payment prose: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(true);
  });
  it.each(["Which item or payment should I check?", "Do you mean the quote or the payment?", "你想查看哪件物品的退款记录？"])("allows procedural clarification without a payment-status assertion: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(false);
  });
});
