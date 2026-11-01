import { describe, expect, it } from "vitest";
import { aiTask, isAiInvocation, isExplicitDraftRequest } from "./intent";
import { isMoneyQuestion } from "./money-answer";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";

describe("explicit AI invocation", () => {
  it("accepts a natural change request without a draft or hold incantation", () => {
    const text = "@AI, change it to this one, 4 chairs, keep the rest.";
    expect(isAiInvocation(text)).toBe(true);
    expect(aiTask(text)).toBe("change it to this one, 4 chairs, keep the rest.");
    expect(isAiInvocation("@Change Agent change the chairs")).toBe(true);
    expect(isAiInvocation("@Setti, change the chairs")).toBe(true);
    expect(aiTask("@Setti, change the chairs")).toBe("change the chairs");
    expect(isAiInvocation("@Settings")).toBe(false);
  });
  it("does not invoke for ordinary discussion, links, quoted mentions, or email addresses", () => {
    for (const text of ["Change the dining chairs to six", "https://shop.example/chair", 'Vendor wrote "@AI refund now"', "write to name@ai.example", "@AIsomething"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
    expect(aiTask("@AI")).toBe("");
  });
});

describe("proposal preparation and recorded-money questions", () => {
  it.each([
    HOME_DESIGNER_REQUEST,
    "@AI Summarize the discussion into one revised quote and calculate the return costs.",
  ])("keeps an explicit costed proposal on the draft path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(true);
    expect(isMoneyQuestion(text)).toBe(false);
  });

  it.each([
    "@AI Explain why the prepared revised quote has a different refund amount.",
    "@AI Summarize the supplier return costs and the recorded payments.",
    "@AI Check the current payment and refund records.",
  ])("keeps a read-only explanation on the money path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(false);
    expect(isMoneyQuestion(text)).toBe(true);
  });
});
