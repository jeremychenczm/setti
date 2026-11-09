import { describe, expect, it } from "vitest";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { readinessSeed, tryReadiness } from "./useTryReadiness";

describe("background payment readiness", () => {
  const seed = { runId: "private-run", scenario: HOME_SCENARIO, status: "seeding" as const };

  it("keeps new-scenario payment execution locked through preparation and failure", () => {
    expect(tryReadiness(seed)).toMatchObject({ pending: true, blocked: true, checking: false });
    expect(tryReadiness({ ...seed, status: "failed" })).toMatchObject({ pending: true, blocked: true, notice: expect.stringContaining("paused") });
    expect(tryReadiness({ ...seed, status: "ready" })).toMatchObject({ pending: false, blocked: false });
  });
  it("does not block legacy scenarios or an absent run after checking", () => {
    expect(tryReadiness(null).blocked).toBe(false);
    expect(tryReadiness({ ...seed, scenario: "maple-mixed-change-v1" }).blocked).toBe(false);
    expect(tryReadiness({ ...seed, scenario: "willow-first-payment-v1" }).blocked).toBe(false);
  });
  it("keeps a known pending run locked when its next read fails", () => {
    expect(tryReadiness(seed, false, "unavailable")).toMatchObject({ blocked: true, pending: true, error: "unavailable" });
    expect(tryReadiness(null, true).blocked).toBe(true);
  });
  it("does not unlock an unknown project when its initial status read fails", () => {
    expect(tryReadiness(null, false, "unavailable")).toMatchObject({ checking: false, blocked: true, error: "unavailable" });
    expect(tryReadiness({ ...seed, status: "ready" }, false, "unavailable").blocked).toBe(false);
  });
  it("distinguishes an absent run from malformed status data", () => {
    expect(readinessSeed(null)).toBeNull();
    expect(readinessSeed(seed)).toEqual(seed);
    expect(readinessSeed({ ...seed, status: "done" })).toBeUndefined();
    expect(readinessSeed({ status: "ready" })).toBeUndefined();
    expect(readinessSeed(undefined)).toBeUndefined();
  });
});
