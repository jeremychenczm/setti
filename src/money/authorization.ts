/**
 * Authorization lifecycle rules (PayPal, US):
 * - an authorization is valid for 29 days;
 * - capture is guaranteed within the first 3 days (the honor period);
 * - it can be reauthorized ONCE, between day 4 and day 29;
 * - reauthorizing gives a new authorization ID and a fresh 3-day honor
 *   period, but does NOT extend the original 29-day expiry.
 *
 * "Day N" means the N-th 24-hour period after the original authorization.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const HONOR_PERIOD_DAYS = 3;
export const AUTHORIZATION_VALIDITY_DAYS = 29;

export interface AuthorizationTimeline {
  authorizedAt: Date;
  now: Date;
  /** Set once the authorization has been reauthorized. */
  reauthorizedAt?: Date;
  hasVault: boolean;
}

export type AuthorizationDecision =
  /** Capturing now is inside an honor period. */
  | { kind: "within_honor_period"; honorEndsAt: Date; expiresAt: Date }
  /** Past the honor period, still valid, and the one reauthorization is unused. */
  | { kind: "reauthorize"; expiresAt: Date }
  /** Past the honor period after the one reauthorization was used: capture is not guaranteed. */
  | {
      kind: "honor_period_lapsed";
      expiresAt: Date;
      /** What to do if the vendor still has not confirmed. */
      fallback: "vault_authorization" | "ask_client_to_pay";
    }
  /** 29 days are up: a brand-new authorization is needed. */
  | { kind: "expired"; expiresAt: Date; next: "vault_authorization" | "ask_client_to_pay" };

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function authorizationExpiresAt(authorizedAt: Date): Date {
  return addDays(authorizedAt, AUTHORIZATION_VALIDITY_DAYS);
}

export function decideAuthorization(t: AuthorizationTimeline): AuthorizationDecision {
  const expiresAt = authorizationExpiresAt(t.authorizedAt);
  const next = t.hasVault ? "vault_authorization" : "ask_client_to_pay";

  if (t.now.getTime() >= expiresAt.getTime()) {
    return { kind: "expired", expiresAt, next };
  }

  if (t.reauthorizedAt) {
    if (t.reauthorizedAt.getTime() < addDays(t.authorizedAt, HONOR_PERIOD_DAYS).getTime()) {
      throw new RangeError("reauthorizedAt is inside the original honor period, which PayPal rejects");
    }
    const honorEndsAt = addDays(t.reauthorizedAt, HONOR_PERIOD_DAYS);
    const cappedHonorEnd = honorEndsAt.getTime() < expiresAt.getTime() ? honorEndsAt : expiresAt;
    if (t.now.getTime() < cappedHonorEnd.getTime()) {
      return { kind: "within_honor_period", honorEndsAt: cappedHonorEnd, expiresAt };
    }
    return { kind: "honor_period_lapsed", expiresAt, fallback: next };
  }

  const honorEndsAt = addDays(t.authorizedAt, HONOR_PERIOD_DAYS);
  if (t.now.getTime() < honorEndsAt.getTime()) {
    return { kind: "within_honor_period", honorEndsAt, expiresAt };
  }
  return { kind: "reauthorize", expiresAt };
}
