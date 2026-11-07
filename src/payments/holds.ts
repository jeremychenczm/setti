/**
 * Where the money on a hold stands. PayPal keeps reporting the original amount
 * on a voided authorization, so the released amount is worked out here from
 * what was actually captured.
 */

export interface HoldSummary {
  authorizedCents: number;
  capturedCents: number;
  /** Still held; some of this amount may be reserved by a pending capture. */
  heldCents: number;
  /** Given back to the client because the hold was closed (voided, expired, or after a final capture). */
  releasedCents: number;
}

export function summarizeHold(input: { authorizedCents: number; capturedCents: number; pendingCaptureCents?: number; closed: boolean }): HoldSummary {
  const uncaptured = Math.max(input.authorizedCents - input.capturedCents, 0);
  return {
    authorizedCents: input.authorizedCents,
    capturedCents: input.capturedCents,
    heldCents: input.closed ? 0 : uncaptured,
    releasedCents: input.closed ? Math.max(uncaptured - (input.pendingCaptureCents ?? 0), 0) : 0,
  };
}
