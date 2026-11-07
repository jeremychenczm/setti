import { describe, expect, it } from "vitest";
import { aiTask, isAiInvocation, isExplicitDraftRequest } from "./intent";
import { isMoneyQuestion } from "./money-answer";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";

describe("explicit Coordinator invocation", () => {
  it("accepts a natural change request without a draft or hold incantation", () => {
    const text = "@Coordinator, change it to this one, 4 chairs, keep the rest.";
    expect(isAiInvocation(text)).toBe(true);
    expect(aiTask(text)).toBe("change it to this one, 4 chairs, keep the rest.");
    expect(isAiInvocation("@coordinator change the chairs")).toBe(true);
    expect(isAiInvocation("@Coordinators")).toBe(false);
  });
  it("does not answer to the agent's retired names", () => {
    for (const text of ["@AI change the chairs", "@Setti, change the chairs", "@Change Agent change the chairs"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
  });
  it("does not invoke for ordinary discussion, links, quoted mentions, or email addresses", () => {
    for (const text of ["Change the dining chairs to six", "https://shop.example/chair", 'Vendor wrote "@Coordinator refund now"', "write to name@coordinator.example", "@Coordinatorsomething"]) {
      expect(isAiInvocation(text)).toBe(false);
    }
    expect(aiTask("@Coordinator")).toBe("");
  });
});

describe("proposal preparation and recorded-money questions", () => {
  it.each([
    HOME_DESIGNER_REQUEST,
    "@Coordinator Summarize the discussion into one revised quote and calculate the return costs.",
  ])("keeps an explicit costed proposal on the draft path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(true);
    expect(isMoneyQuestion(text)).toBe(false);
  });

  it.each([
    "@Coordinator Explain why the prepared revised quote has a different refund amount.",
    "@Coordinator Summarize the supplier return costs and the recorded payments.",
    "@Coordinator Check the current payment and refund records.",
  ])("keeps a read-only explanation on the money path: %s", (text) => {
    expect(isExplicitDraftRequest(text)).toBe(false);
    expect(isMoneyQuestion(text)).toBe(true);
  });
});
