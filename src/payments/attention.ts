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

export type AttentionKind = "payment_unknown" | "hold_failed" | "renewal_failed" | "expired" | "capture_ready" | "expiring" | "honor_lapsed" | "supplier_unconfirmed";

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

const ORDER: AttentionKind[] = ["payment_unknown", "hold_failed", "renewal_failed", "expired", "capture_ready", "expiring", "honor_lapsed", "supplier_unconfirmed"];

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
  if (line.renewal) {
    return { kind: "renewal_failed", title: `${line.label} · renewal failed`, detail: `Setti could not renew the hold: ${line.renewal.message} The current hold still ends ${day(new Date(line.timing.expiresAt))}. Ask the client to approve a new hold, or cancel the item.`, urgency: "now" };
  }

  const authorizedAt = new Date(line.timing.authorizedAt), honorEndsAt = new Date(line.timing.honorEndsAt), expiresAt = new Date(line.timing.expiresAt);
  const elapsed = now.getTime() - authorizedAt.getTime();
  if (now.getTime() >= expiresAt.getTime()) {
    return { kind: "expired", title: `${line.label} · the hold expired`, detail: `Its 29 days ended on ${day(expiresAt)}. Check PayPal, then hold it again or cancel the item.`, urgency: "now" };
  }
  const expiring = now.getTime() >= expiresAt.getTime() - EXPIRY_NOTICE_DAYS * DAY_MS;
  const renewal = view.savedMethod
    ? `Setti renews it on ${day(new Date(authorizedAt.getTime() + RENEWAL_DAY * DAY_MS))} with the client's saved payment method.`
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

/** The day Setti replaces a hold still waiting for its supplier, with the client's saved payment method. */
export const RENEWAL_DAY = 25;
/** The renewal waits at least this long after its notice. */
export const NOTICE_LEAD_DAYS = 2;

/**
 * The items whose hold gets the renewal notice at `now`: held, the supplier has
 * not confirmed, a payment method is saved, in the last week before expiry.
 */
export function renewalNoticesDue(view: ItemHoldsView, now: Date): ItemHoldView[] {
  if (!view.savedMethod) return [];
  return view.items.filter((line) => {
    if (line.state !== "held" || !line.timing) return false;
    const expiresAt = new Date(line.timing.expiresAt).getTime();
    return now.getTime() >= expiresAt - EXPIRY_NOTICE_DAYS * DAY_MS && now.getTime() < expiresAt;
  });
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/** A notice lists this many items in full; the rest by name. */
const LISTED = 8;

/**
 * The automatic notice both people read in the project chat, a few days before
 * Setti replaces holds. It is the one warning that holds are about to be
 * renewed, so it says how to stop it. One notice covers every hold of the
 * project that came due together.
 */
export function renewalNotice(input: { lines: ItemHoldView[]; client: string; designer: string; method: { kind: "paypal" | "card"; label: string | null }; now: Date }): string {
  const client = input.client.split(" ")[0], designer = input.designer.split(" ")[0];
  const method = input.method.kind === "card" ? `saved card${input.method.label ? ` (${input.method.label})` : ""}` : "saved PayPal";
  // Day 25, or two days after this notice if it comes late: the notice always leaves that long to stop it.
  const renewOn = (line: ItemHoldView) => new Date(Math.max(new Date(line.timing!.authorizedAt).getTime() + RENEWAL_DAY * DAY_MS, input.now.getTime() + NOTICE_LEAD_DAYS * DAY_MS));
  const entries = input.lines.map((line) => ({ line, ends: day(new Date(line.timing!.expiresAt)), renew: day(renewOn(line)) }));
  if (entries.length === 1) {
    const [{ line, ends, renew }] = entries;
    return `Heads-up for ${client} and ${designer}: the ${usd(line.heldCents)} hold for ${line.label} ends ${ends}, because PayPal holds last 29 days, and ${line.vendor ?? "the supplier"} hasn't confirmed the order yet. `
      + `On ${renew} Setti will replace it with a new hold of the same amount on ${client}'s ${method}, so nothing is charged and ${client} doesn't need to do anything. `
      + `If the project or this item has stopped, ${designer} can cancel the hold before then.`;
  }
  const sameEnd = entries.every((entry) => entry.ends === entries[0].ends), sameRenew = entries.every((entry) => entry.renew === entries[0].renew);
  const total = entries.reduce((sum, entry) => sum + entry.line.heldCents, 0);
  const listed = entries.slice(0, LISTED).map((entry) => `• ${entry.line.label} · ${usd(entry.line.heldCents)}${sameEnd ? "" : ` · ends ${entry.ends}`}`);
  const rest = entries.slice(LISTED);
  return `Heads-up for ${client} and ${designer}: ${entries.length} holds ${sameEnd ? `end ${entries[0].ends}` : "end within the week"}, because PayPal holds last 29 days, and their suppliers haven't confirmed the orders yet:\n`
    + `${listed.join("\n")}${rest.length ? `\n• and ${rest.length} more: ${rest.map((entry) => entry.line.label).join(", ")}` : ""}\n`
    + `${sameRenew ? `On ${entries[0].renew}` : "A few days before each one ends,"} Setti will replace each with a new hold of the same amount on ${client}'s ${method} (${usd(total)} in all), so nothing is charged and ${client} doesn't need to do anything. `
    + `If the project or any of these items has stopped, ${designer} can cancel those holds before then.`;
}
