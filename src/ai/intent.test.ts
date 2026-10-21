import { describe, expect, it } from "vitest";
import { aiTask, isAiInvocation } from "./intent";

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
