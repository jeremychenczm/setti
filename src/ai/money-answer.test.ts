import { describe, expect, it } from "vitest";
import { buildMoneyAnswer, hasUnsupportedMoneyClaim, isMoneyQuestion } from "./money-answer";
import type { MoneyContext } from "./money-types";

function evidence(): MoneyContext {
  return {
    projectKey: "maple", quoteId: "demo-maple-v1", version: 1, checkedAt: "2026-10-21T20:00:00Z", providerRecordedAt: null, mode: "recorded_sandbox",
    sources: [{ id: "quote", kind: "quote", label: "Approved quote", href: "/quotes/maple", recordedAt: null }],
    facts: [
      { id: "budget", text: { en: "Budget changed by $60." }, sourceIds: ["quote"] },
      { id: "unknown", text: { en: "No recorded payment evidence." }, sourceIds: ["quote"] },
    ], mandatoryFactIds: ["unknown"],
  };
}

describe("recorded money answers", () => {
  it("renders only server facts, always retains uncertainty, and snapshots their evidence", () => {
    const context = evidence();
    const result = buildMoneyAnswer(context, ["budget"]);
    expect(result.moneyAnswer.facts.map((f) => f.id)).toEqual(["budget", "unknown"]);
    expect(result.moneyAnswer.sources).toEqual(context.sources);
    expect(result.text).toContain("recorded approvals and payments");
    context.facts[0].text.en = "Changed later";
    context.sources[0].label = "Changed later";
    expect(result.moneyAnswer.facts[0].text.en).toBe("Budget changed by $60.");
    expect(result.moneyAnswer.sources[0].label).toBe("Approved quote");
  });
  it.each([{ ids: [] }, { ids: ["foreign"] }, { ids: ["budget", "budget"] }])("rejects invalid fact selection $ids", ({ ids }) => {
    expect(() => buildMoneyAnswer(evidence(), ids)).toThrow();
  });
  it("rejects invented citations and external source links", () => {
    const context = evidence();
    context.facts[0].sourceIds = ["fake"];
    expect(() => buildMoneyAnswer(context, ["budget"])).toThrow();
    context.facts[0].sourceIds = ["quote"];
    context.sources[0].href = "https://evil.example/pay";
    expect(() => buildMoneyAnswer(context, ["budget"])).toThrow();
  });
  it.each(["@AI Why was the desk charged when the rug is not refunded yet?", "@AI Explain the holds and refunds.", "@AI Where is my money?", "@AI Check this budget and payment status", "@AI Why did we replace the chair and pay more?", "@AI Please explain why replacing the chair cost more."])('recognizes a read-only money question: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(true);
  });
  it.each(["@AI Change the dining chairs from four to six, keep the rest.", "@AI Return the rug and replace the chair with a desk.", "@AI Return the rug, make it two desks", "@AI, change the dining chairs from four to six and show how much it costs.", "@AI Can you replace the chair and show the cost?", "@AI Could you please replace the chair and show the cost?", "@AI Please replace the chair and show the cost."])('keeps natural change requests on the draft path: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(false);
  });
  it.each(["You already paid $999.", "The refund completed.", "The authorization result is unknown.", "The rug has not been refunded.", "The desk is not paid.", "Payment has not been received.", "\u9000\u6b3e\u5b8c\u6210\u3002"])("blocks unsupported payment prose: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(true);
  });
  it.each(["Which item or payment should I check?", "Do you mean the quote or the payment?"])("allows procedural clarification without a payment-status assertion: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(false);
  });
});
