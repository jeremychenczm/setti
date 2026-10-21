/**
 * Authorization timing (PayPal checkout docs, checked 2026-10-20):
 * - an authorization reserves funds for up to 29 days;
 * - capture has the highest success rate within the first 3 days (the honor
 *   period); it is not guaranteed, and PayPal or the bank can still decline it;
 * - after day 3 it may be reauthorized (days 4-29); the new authorization has
 *   its own 3-day honor period and does not extend the original 29 days.
 *
 * PayPal does not promise a number of reauthorizations, so Setti plans for at
 * most one and treats a lapsed second honor period as "capture not assured".
 * That is Setti's own conservative policy, never a promise to the client.
 * Sandbox authorizations do not expire on their own; expiry is tested with
 * PayPal's negative testing instead.
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
  /** Past the honor period after the one planned reauthorization: capture is not assured. */
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
