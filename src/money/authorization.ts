/**
 * Authorization timing (PayPal checkout docs, checked 2026-10-20):
 * - an authorization reserves funds for up to 29 days;
 * - capture has the highest success rate within the first 3 days (the honor
 *   period); it is not guaranteed, and PayPal or the bank can still decline it.
 *
 * Sandbox authorizations do not expire on their own; expiry is tested with
 * PayPal's negative testing instead.
 */

export const HONOR_PERIOD_DAYS = 3;
export const AUTHORIZATION_VALIDITY_DAYS = 29;
