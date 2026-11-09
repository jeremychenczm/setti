import { describe, expect, it } from "vitest";
import { aiTask, isAiInvocation, isExplicitDraftRequest } from "./intent";
import { isMoneyQuestion } from "./money-answer";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";

describe("explicit Setti invocation", () => {
  it("accepts a natural change request without a draft or hold incantation", () => {
    const text = "@Setti, change it to this one, 4 chairs, keep the rest.";
    expect(isAiInvocation(text)).toBe(true);
    expect(aiTask(text)).toBe("change it to this one, 4 chairs, keep the rest.");
    expect(isAiInvocation("@setti change the chairs")).toBe(true);
    expect(isAiInvocation("@Settis")).toBe(false);
  });
  it("does not answer to the agent's retired names", () => {
    for (const text of ["@AI change the chairs", "@Coordinator, change the chairs", "@Change Agent change the chairs"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
  });
  it("does not invoke for ordinary discussion, links, quoted mentions, or email addresses", () => {
    for (const text of ["Change the dining chairs to six", "https://shop.example/chair", 'Vendor wrote "@Setti refund now"', "write to name@setti.example", "@Settisomething"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
    expect(aiTask("@Setti")).toBe("");
  });
});

describe("proposal preparation and recorded-money questions", () => {
  it.each([
    HOME_DESIGNER_REQUEST,
    "@Setti Summarize the discussion into one revised quote and calculate the return costs.",
  ])("keeps an explicit costed proposal on the draft path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(true);
    expect(isMoneyQuestion(text)).toBe(false);
  });

  it.each([
    "@Setti Explain why the prepared revised quote has a different refund amount.",
    "@Setti Summarize the supplier return costs and the recorded payments.",
    "@Setti Check the current payment and refund records.",
  ])("keeps a read-only explanation on the money path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(false);
    expect(isMoneyQuestion(text)).toBe(true);
  });
});
