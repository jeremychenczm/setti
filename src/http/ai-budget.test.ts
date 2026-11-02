import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAiBudget, takeAiBudget } from "./ai-budget";

describe("the AI budget of a demo server", () => {
  beforeEach(() => resetAiBudget());
  afterEach(() => vi.unstubAllEnvs());

  it("allows each session a number of calls per hour, then again after the hour", () => {
    vi.stubEnv("SETTI_AI_PER_HOUR", "2");
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(takeAiBudget("a", now)).toBeNull();
    expect(takeAiBudget("a", now + 1)).toBeNull();
    expect(takeAiBudget("a", now + 2)).toMatch(/many times this hour/);
    expect(takeAiBudget("b", now + 3)).toBeNull();
    expect(takeAiBudget("a", now + 60 * 60 * 1000 + 1)).toBeNull();
  });

  it("stops every session once the day's budget is used", () => {
    vi.stubEnv("SETTI_AI_PER_DAY", "3");
    const now = Date.parse("2026-11-01T12:00:00Z");
    for (const session of ["a", "b", "c"]) expect(takeAiBudget(session, now)).toBeNull();
    expect(takeAiBudget("d", now)).toMatch(/today's AI budget/);
    expect(takeAiBudget("d", Date.parse("2026-11-02T00:00:01Z"))).toBeNull();
  });
});
