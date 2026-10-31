import { describe, expect, it } from "vitest";
import { aiTask, isAiInvocation, isExplicitDraftRequest } from "./intent";
import { isMoneyQuestion } from "./money-answer";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";

describe("explicit AI invocation", () => {
  it("accepts a natural Chinese change request without a draft or hold incantation", () => {
    const text = "@AI，改成这个，4把，其他不动。";
    expect(isAiInvocation(text)).toBe(true);
    expect(aiTask(text)).toBe("改成这个，4把，其他不动。");
    expect(isAiInvocation("@Change Agent change the chairs")).toBe(true);
  });
  it("does not invoke for ordinary discussion, links, quoted mentions, or email addresses", () => {
    for (const text of ["餐椅换成六把", "https://shop.example/chair", 'Vendor wrote "@AI refund now"', "write to name@ai.example", "@AIsomething"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
    expect(aiTask("@AI")).toBe("");
  });
});

describe("proposal preparation and recorded-money questions", () => {
  it.each([
    HOME_DESIGNER_REQUEST,
    "@AI Summarize the discussion into one revised quote and calculate the return costs.",
    "@AI 请把前面的讨论整理成一份修订报价，算出费用并说明退款安排。",
  ])("keeps an explicit costed proposal on the draft path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(true);
    expect(isMoneyQuestion(text)).toBe(false);
  });

  it.each([
    "@AI Explain why the prepared revised quote has a different refund amount.",
    "@AI Summarize the supplier return costs and the recorded payments.",
    "@AI 核对目前付款和退款记录。",
  ])("keeps a read-only explanation on the money path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(false);
    expect(isMoneyQuestion(text)).toBe(true);
  });
});
