/**
 * Where the money on a hold stands. PayPal keeps reporting the original amount
 * on a voided authorization, so the released amount is worked out here from
 * what was actually captured.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paypalAuthorizations, paypalCaptures } from "../db/schema";

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

export async function holdSummary(db: Db, authorizationId: string): Promise<HoldSummary> {
  const [authorization] = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId));
  if (!authorization) throw new Error(`Authorization ${authorizationId} does not exist`);

  const captures = await db
    .select({ amountCents: paypalCaptures.amountCents, finalCapture: paypalCaptures.finalCapture, status: paypalCaptures.status })
    .from(paypalCaptures)
    .where(eq(paypalCaptures.authorizationId, authorizationId));

  const completed = captures.filter((capture) => capture.status === "completed");
  const closed = ["voided", "expired", "captured"].includes(authorization.status) || completed.some((capture) => capture.finalCapture)
    || !!(authorization.expiresAt && authorization.expiresAt.getTime() <= Date.now());
  return summarizeHold({
    authorizedCents: authorization.amountCents,
    capturedCents: completed.reduce((total, capture) => total + capture.amountCents, 0),
    pendingCaptureCents: captures.filter((capture) => capture.status === "pending").reduce((total, capture) => total + capture.amountCents, 0),
    closed,
  });
}
