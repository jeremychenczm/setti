import type { Cents } from "./types";

/** PayPal (US) lets a capture exceed the authorization by 15% or $75, whichever is less. */
export const OVER_CAPTURE_PERCENT = 15;
export const OVER_CAPTURE_MAX_CENTS: Cents = 7_500;

export function assertCents(value: number, name = "amount"): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents (got ${value})`);
  }
}

/** Largest amount that may be captured above `authorizedCents`. Rounded down to stay on the safe side. */
export function overCaptureAllowance(authorizedCents: Cents): Cents {
  assertCents(authorizedCents, "authorizedCents");
  return Math.min(Math.floor((authorizedCents * OVER_CAPTURE_PERCENT) / 100), OVER_CAPTURE_MAX_CENTS);
}

/** Restocking fee in cents, from basis points (2000 = 20%). */
export function restockingFee(capturedCents: Cents, feeBps: number): Cents {
  assertCents(capturedCents, "capturedCents");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError(`feeBps must be an integer between 0 and 10000 (got ${feeBps})`);
  }
  return Math.round((capturedCents * feeBps) / 10_000);
}
