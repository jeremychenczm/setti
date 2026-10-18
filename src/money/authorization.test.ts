import { describe, expect, it } from "vitest";
import { decideAuthorization } from "./authorization";

const DAY = 24 * 60 * 60 * 1000;
const authorizedAt = new Date("2026-10-01T12:00:00Z");
const at = (days: number) => new Date(authorizedAt.getTime() + days * DAY);

describe("authorization timeline", () => {
  it("day 3: still inside the honor period, no reauthorization yet", () => {
    const d = decideAuthorization({ authorizedAt, now: at(2.5), hasVault: true });
    expect(d).toEqual({ kind: "within_honor_period", honorEndsAt: at(3), expiresAt: at(29) });
  });

  it("day 4: eligible for the single reauthorization", () => {
    expect(decideAuthorization({ authorizedAt, now: at(3.5), hasVault: true })).toEqual({
      kind: "reauthorize",
      expiresAt: at(29),
    });
  });

  it("day 30: expired, so a new authorization is needed", () => {
    expect(decideAuthorization({ authorizedAt, now: at(29.5), hasVault: true })).toEqual({
      kind: "expired",
      expiresAt: at(29),
      next: "vault_authorization",
    });
    expect(decideAuthorization({ authorizedAt, now: at(29.5), hasVault: false })).toMatchObject({
      next: "ask_client_to_pay",
    });
  });

  it("after reauthorizing once, a fresh 3-day honor period starts but the expiry does not move", () => {
    const d = decideAuthorization({ authorizedAt, reauthorizedAt: at(5), now: at(6), hasVault: true });
    expect(d).toEqual({ kind: "within_honor_period", honorEndsAt: at(8), expiresAt: at(29) });
  });

  it("already reauthorized once: no second reauthorization once that honor period lapses", () => {
    expect(decideAuthorization({ authorizedAt, reauthorizedAt: at(5), now: at(9), hasVault: true })).toEqual({
      kind: "honor_period_lapsed",
      expiresAt: at(29),
      fallback: "vault_authorization",
    });
    expect(
      decideAuthorization({ authorizedAt, reauthorizedAt: at(5), now: at(9), hasVault: false }),
    ).toMatchObject({ fallback: "ask_client_to_pay" });
  });

  it("caps the post-reauthorization honor period at the original expiry", () => {
    const d = decideAuthorization({ authorizedAt, reauthorizedAt: at(27.5), now: at(28), hasVault: true });
    expect(d).toEqual({ kind: "within_honor_period", honorEndsAt: at(29), expiresAt: at(29) });
  });

  it("rejects a reauthorization recorded inside the original honor period", () => {
    expect(() => decideAuthorization({ authorizedAt, reauthorizedAt: at(1), now: at(2), hasVault: true })).toThrow(
      RangeError,
    );
  });
});
