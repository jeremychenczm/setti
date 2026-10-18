import { describe, expect, it } from "vitest";
import { classifyFailure } from "./paypal";

describe("classifyFailure", () => {
  it("treats business errors as rejected, keeping PayPal's issue code", () => {
    expect(classifyFailure({ statusCode: 422, code: "MAX_CAPTURE_AMOUNT_EXCEEDED", message: "no", debugId: "d1" })).toEqual({
      kind: "rejected",
      code: "MAX_CAPTURE_AMOUNT_EXCEEDED",
      message: "no",
      debugId: "d1",
    });
  });

  it("treats server errors and timeouts as unknown, because PayPal may have acted", () => {
    expect(classifyFailure({ statusCode: 500, message: "boom" }).kind).toBe("unknown");
    expect(classifyFailure({ statusCode: 408, message: "slow" }).kind).toBe("unknown");
    expect(classifyFailure({ message: "socket hang up", networkCode: "ECONNRESET" }).kind).toBe("unknown");
    expect(classifyFailure({ message: "timeout" }).kind).toBe("unknown");
  });

  it("treats rate limits and requests that never left the machine as retryable", () => {
    expect(classifyFailure({ statusCode: 429, message: "slow down" }).kind).toBe("retryable");
    expect(classifyFailure({ message: "refused", networkCode: "ECONNREFUSED" }).kind).toBe("retryable");
  });
});
