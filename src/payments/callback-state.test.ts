import { describe, expect, it } from "vitest";
import { callbackState, validCallbackState } from "./callback-state";

describe("private PayPal callback state", () => {
  const id = "7dbfdaf0-46ce-49d6-91b7-f3867e652c58", secret = "test-server-secret";

  it("accepts the original operation and route without relying on a browser cookie", () => {
    for (const outcome of ["return", "cancel"] as const) {
      expect(validCallbackState(id, outcome, callbackState(id, outcome, secret), secret)).toBe(true);
    }
  });

  it("rejects missing, altered, cross-operation and cross-route state", () => {
    const state = callbackState(id, "return", secret);
    expect(validCallbackState(id, "return", null, secret)).toBe(false);
    expect(validCallbackState(id, "return", "x", secret)).toBe(false);
    expect(validCallbackState(id, "return", state.replace(/^./, state[0] === "x" ? "y" : "x"), secret)).toBe(false);
    expect(validCallbackState("another-operation", "return", state, secret)).toBe(false);
    expect(validCallbackState(id, "cancel", state, secret)).toBe(false);
    expect(validCallbackState(id, "return", state, "another-server-secret")).toBe(false);
  });
});
