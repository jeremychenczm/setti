/**
 * What needs the designer today, worked out from recorded money only: holds
 * whose supplier has not confirmed, honor periods that ran out, confirmed items
 * not captured yet, holds near their 29-day expiry or past it, and PayPal steps
 * with no settled result. One reminder per item, the most pressing one. Pure:
 * the clock is an argument, so every boundary is testable and a demo can ask
 * about a later day.
 *
 * Authorization timing (see money/authorization.ts): day N is the N-th 24 hours
 * after PayPal authorized the hold; capture is assured in the first 3 days; a
 * hold lasts 29 days.
 */
import type { CaseKey } from "../chat/types";
import type { ItemHoldView, ItemHoldsView } from "./item-holds-view";

export type AttentionKind = "payment_unknown" | "hold_failed" | "expired" | "capture_ready" | "expiring" | "honor_lapsed" | "supplier_unconfirmed";

export interface AttentionItem {
  /** Stable per project, item and kind. */
  id: string;
  kind: AttentionKind;
  projectKey: CaseKey;
  projectName: string;
  /** The quote line, and its side of a replacement. */
  itemId: string;
  side: "baseline" | "proposed";
  itemLabel: string;
  title: string;
  detail: string;
  /** `now`: act today; `soon`: within a few days. */
  urgency: "now" | "soon";
  /** Where the designer acts on it. */
  href: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A week before a hold expires, Setti starts saying so. */
export const EXPIRY_NOTICE_DAYS = 7;

const ORDER: AttentionKind[] = ["payment_unknown", "hold_failed", "expired", "capture_ready", "expiring", "honor_lapsed", "supplier_unconfirmed"];

const day = (value: Date) => value.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

/** Where an item's next step is: the quote's approved items on V1, the version's payments page after it. */
function itemHref(view: ItemHoldsView, line: ItemHoldView): string {
  return view.basis?.orderId
    ? `/change-orders/${view.basis.orderId}#payment-line-${line.side}-${line.itemId}`
    : `/quotes/${view.projectKey}?hold=${encodeURIComponent(line.itemId)}#item-holds`;
}

/** The one reminder an item needs at `now`, if any. */
function reminder(view: ItemHoldsView, line: ItemHoldView, now: Date): Pick<AttentionItem, "kind" | "title" | "detail" | "urgency"> | null {
  const supplier = line.vendor ?? "The supplier";
  if (line.state === "unknown") return { kind: "payment_unknown", title: `${line.label} · PayPal result unknown`, detail: "Check its PayPal status before doing anything else with this item.", urgency: "now" };
  if (line.state === "failed") return { kind: "hold_failed", title: `${line.label} · the hold failed`, detail: line.failureMessage ?? "Hold it again, or cancel the item.", urgency: "now" };
  if (line.expiredAt && line.state === "to_hold") {
    return { kind: "expired", title: `${line.label} · the hold expired`, detail: `It lapsed on ${day(new Date(line.expiredAt))}, so nothing is held for it. Hold it again, or cancel the item.`, urgency: "now" };
  }
  if ((line.state !== "held" && line.state !== "confirmed") || !line.timing) return null;

  const authorizedAt = new Date(line.timing.authorizedAt), honorEndsAt = new Date(line.timing.honorEndsAt), expiresAt = new Date(line.timing.expiresAt);
  const elapsed = now.getTime() - authorizedAt.getTime();
  if (now.getTime() >= expiresAt.getTime()) {
    return { kind: "expired", title: `${line.label} · the hold expired`, detail: `Its 29 days ended on ${day(expiresAt)}. Check PayPal, then hold it again or cancel the item.`, urgency: "now" };
  }
  const expiring = now.getTime() >= expiresAt.getTime() - EXPIRY_NOTICE_DAYS * DAY_MS;
  // Renewing it is a new hold of the same amount: with a saved method the client need not approve it again.
  const renewal = view.savedMethod
    ? `A new hold can replace it with the client's saved payment method, without asking the client again.`
    : "No payment method is saved, so the client has to approve a new hold.";
  if (line.state === "confirmed") {
    const assured = now.getTime() < honorEndsAt.getTime();
    return {
      kind: "capture_ready", title: `${line.label} · ready to capture`,
      detail: `${supplier} confirmed the order. ${assured ? `Capture is assured until ${day(honorEndsAt)}.` : "The 3-day honor period has ended, so capture is no longer assured."}${expiring ? ` The hold expires ${day(expiresAt)}.` : ""}`,
      urgency: assured && !expiring ? "soon" : "now",
    };
  }
  if (expiring) return { kind: "expiring", title: `${line.label} · hold expires ${day(expiresAt)}`, detail: `${supplier} still hasn't confirmed the order. ${renewal}`, urgency: view.savedMethod ? "soon" : "now" };
  if (now.getTime() >= honorEndsAt.getTime()) {
    return { kind: "honor_lapsed", title: `${line.label} · still no supplier confirmation`, detail: `${supplier} hasn't confirmed the order and the 3-day honor period has ended, so capture is no longer assured. Confirm the order or cancel the hold.`, urgency: "now" };
  }
  if (elapsed >= DAY_MS) {
    const holdDay = Math.min(3, Math.floor(elapsed / DAY_MS) + 1);
    return { kind: "supplier_unconfirmed", title: `${line.label} · supplier hasn't confirmed`, detail: `${supplier} · hold day ${holdDay} of 3. Capture is assured until ${day(honorEndsAt)}.`, urgency: holdDay >= 3 ? "now" : "soon" };
  }
  return null;
}

/** Every reminder of one project at `now`. */
export function projectAttention(view: ItemHoldsView, projectName: string, now: Date): AttentionItem[] {
  return view.items.flatMap((line) => {
    const found = reminder(view, line, now);
    return found ? [{ ...found, id: `${view.projectKey}:${line.side}:${line.itemId}:${found.kind}`, projectKey: view.projectKey, projectName, itemId: line.itemId, side: line.side, itemLabel: line.label, href: itemHref(view, line) }] : [];
  });
}

/** Most pressing first: act-today before soon, then by kind, then by project and item. */
export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "now" ? -1 : 1)
    || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.projectName.localeCompare(b.projectName) || a.itemLabel.localeCompare(b.itemLabel));
}
