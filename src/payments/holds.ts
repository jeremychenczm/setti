/**
 * Where the money on a hold stands. PayPal keeps reporting the original amount
 * on a voided authorization, so the released amount is worked out here from
 * what was actually captured.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { paypalAuthorizations, paypalCaptures } from "../db/schema";

export interface HoldSummary {
  authorizedCents: number;
  capturedCents: number;
  /** Still held and available to capture. */
  heldCents: number;
  /** Given back to the client because the hold was closed (voided, expired, or after a final capture). */
  releasedCents: number;
}

export function summarizeHold(input: { authorizedCents: number; capturedCents: number; closed: boolean }): HoldSummary {
  const uncaptured = Math.max(input.authorizedCents - input.capturedCents, 0);
  return {
    authorizedCents: input.authorizedCents,
    capturedCents: input.capturedCents,
    heldCents: input.closed ? 0 : uncaptured,
    releasedCents: input.closed ? uncaptured : 0,
  };
}

export async function holdSummary(db: Db, authorizationId: string): Promise<HoldSummary> {
  const [authorization] = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, authorizationId));
  if (!authorization) throw new Error(`Authorization ${authorizationId} does not exist`);

  const captures = await db
    .select({ amountCents: paypalCaptures.amountCents, finalCapture: paypalCaptures.finalCapture })
    .from(paypalCaptures)
    .where(and(eq(paypalCaptures.authorizationId, authorizationId), ne(paypalCaptures.status, "declined")));

  const closed = authorization.status === "voided" || authorization.status === "expired" || captures.some((c) => c.finalCapture);
  return summarizeHold({
    authorizedCents: authorization.amountCents,
    capturedCents: captures.reduce((total, c) => total + c.amountCents, 0),
    closed,
  });
}
