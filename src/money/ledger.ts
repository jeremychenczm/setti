/**
 * Ledger snapshot from PayPal-side events. "Received" counts captures only;
 * holds are reported separately and a pending refund is not subtracted from
 * the net until it completes.
 */
import type { Cents } from "./types";

export type LedgerEvent =
  | { type: "authorized"; id: string; amountCents: Cents }
  | { type: "voided"; authorizationId: string }
  | {
      type: "captured";
      id: string;
      amountCents: Cents;
      /** Set when the capture comes from an authorization. */
      authorizationId?: string;
      /** A final capture closes the authorization and releases what is left. */
      final?: boolean;
    }
  | { type: "refunded"; id: string; captureId: string; amountCents: Cents; status: "pending" | "completed" };

export interface LedgerSnapshot {
  receivedCents: Cents;
  refundedCents: Cents;
  refundPendingCents: Cents;
  heldCents: Cents;
  netCents: Cents;
}

export function ledgerSnapshot(events: LedgerEvent[]): LedgerSnapshot {
  const auths = new Map<string, { amount: Cents; captured: Cents; closed: boolean }>();
  let receivedCents = 0;
  let refundedCents = 0;
  let refundPendingCents = 0;

  for (const e of events) {
    switch (e.type) {
      case "authorized":
        auths.set(e.id, { amount: e.amountCents, captured: 0, closed: false });
        break;
      case "voided": {
        const a = auths.get(e.authorizationId);
        if (!a) throw new Error(`void for unknown authorization ${e.authorizationId}`);
        a.closed = true;
        break;
      }
      case "captured": {
        receivedCents += e.amountCents;
        if (e.authorizationId) {
          const a = auths.get(e.authorizationId);
          if (!a) throw new Error(`capture for unknown authorization ${e.authorizationId}`);
          a.captured += e.amountCents;
          if (e.final) a.closed = true;
        }
        break;
      }
      case "refunded":
        if (e.status === "completed") refundedCents += e.amountCents;
        else refundPendingCents += e.amountCents;
        break;
    }
  }

  let heldCents = 0;
  for (const a of auths.values()) {
    if (!a.closed) heldCents += Math.max(a.amount - a.captured, 0);
  }

  return {
    receivedCents,
    refundedCents,
    refundPendingCents,
    heldCents,
    netCents: receivedCents - refundedCents,
  };
}
