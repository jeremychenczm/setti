import { afterEach, describe, expect, it, vi } from "vitest";
import setup from "./global-setup";

describe("test database setup", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails in CI instead of silently skipping the database tests", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("CI", "true");
    await expect(setup()).rejects.toThrow("TEST_DATABASE_URL is not set in CI");
  });

  it("still lets a local run skip the database tests without Docker", async () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("CI", "");
    await expect(setup()).resolves.toBeUndefined();
  });
});
