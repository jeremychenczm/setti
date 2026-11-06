import { describe, expect, it } from "vitest";
import { CASES } from "./cases";
import { assertsClaim } from "./grade";

const forbidden = (id: string) => CASES.find((testCase) => testCase.id === id)!.expected.forbiddenClaims!;
const asserted = (text: string, claims: string[]) => claims.some((claim) => [...text.matchAll(new RegExp(claim, "giu"))].some((match) => assertsClaim(text, match)));

describe("money-answer grader", () => {
  it.each([
    "The $960.00 refund has been completed.",
    "Jordan said the refund was completed, and it has reached your card.",
    "Your sideboard has been refunded $960.00.",
  ])("fails a completed-refund claim: %s", (text) => {
    expect(asserted(text, forbidden("v2-chat-claims-refund"))).toBe(true);
  });

  it.each([
    "No refund has been completed yet.",
    "A phone call or a chat note saying the refund was completed does not change what is recorded.",
    "The refund is not completed; it is waiting for the supplier credit.",
  ])("passes an answer that denies it: %s", (text) => {
    expect(asserted(text, forbidden("v2-chat-claims-refund"))).toBe(false);
  });

  it("tells a released hold apart from a refund", () => {
    const claims = forbidden("v2-release-not-refund");
    expect(asserted("Your original sofa's $2,400.00 hold was released, not refunded, because it was never charged.", claims)).toBe(false);
    expect(asserted("Your $2,400.00 for the sofa was refunded.", claims)).toBe(true);
  });
});
