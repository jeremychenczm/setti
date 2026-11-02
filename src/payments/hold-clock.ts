/**
 * When a hold's days started and when its 29 days end, as Setti counts them.
 * A hold PayPal placed for a checkout or a saved method counts from when it was
 * recorded, and ends when PayPal said it expires. A hold that renewed an older
 * one counts from the clock of the run that renewed it, which may be ahead of
 * real time when a run checks ahead (`--days`, a demo's simulated time).
 * Everything that judges a hold's age uses this, so the reminders, the notices
 * and the renewals agree.
 */
import { AUTHORIZATION_VALIDITY_DAYS } from "../money/authorization";

const DAY_MS = 24 * 60 * 60 * 1000;

export function holdClock(
  hold: { createdAt: Date; expiresAt: Date | null; operationId: string | null },
  operations: readonly { id: string; renewedAt: Date | null }[],
): { authorizedAt: Date; expiresAt: Date; renewed: boolean } {
  const renewedAt = hold.operationId ? operations.find((operation) => operation.id === hold.operationId)?.renewedAt ?? null : null;
  if (renewedAt) return { authorizedAt: renewedAt, expiresAt: new Date(renewedAt.getTime() + AUTHORIZATION_VALIDITY_DAYS * DAY_MS), renewed: true };
  return { authorizedAt: hold.createdAt, expiresAt: hold.expiresAt ?? new Date(hold.createdAt.getTime() + AUTHORIZATION_VALIDITY_DAYS * DAY_MS), renewed: false };
}
