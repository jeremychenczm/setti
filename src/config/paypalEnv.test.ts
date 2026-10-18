import { describe, expect, it } from "vitest";
import { assertSandbox, SandboxGuardError } from "./paypalEnv";

const valid = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
};

describe("assertSandbox", () => {
  it("returns credentials for a sandbox configuration", () => {
    expect(assertSandbox(valid)).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("accepts an explicit sandbox base URL", () => {
    expect(() =>
      assertSandbox({ ...valid, PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" }),
    ).not.toThrow();
  });

  it("rejects a missing PAYPAL_ENV", () => {
    expect(() => assertSandbox({ ...valid, PAYPAL_ENV: undefined })).toThrow(SandboxGuardError);
  });

  it("rejects a live environment", () => {
    expect(() => assertSandbox({ ...valid, PAYPAL_ENV: "production" })).toThrow(/sandbox/);
    expect(() => assertSandbox({ ...valid, PAYPAL_ENV: "live" })).toThrow(SandboxGuardError);
  });

  it("rejects a base URL that is not the sandbox host", () => {
    expect(() =>
      assertSandbox({ ...valid, PAYPAL_BASE_URL: "https://api-m.paypal.com" }),
    ).toThrow(/api-m.sandbox.paypal.com/);
    expect(() => assertSandbox({ ...valid, PAYPAL_BASE_URL: "not a url" })).toThrow(
      SandboxGuardError,
    );
  });

  it("rejects missing credentials", () => {
    expect(() => assertSandbox({ ...valid, PAYPAL_CLIENT_SECRET: "" })).toThrow(/required/);
    expect(() => assertSandbox({ ...valid, PAYPAL_CLIENT_ID: undefined })).toThrow(
      SandboxGuardError,
    );
  });
});
