/**
 * What the inbox draws, worked out from the server's view: the designer's
 * to-dos grouped by what to do and by project, and the client's items with
 * their PayPal records. Every sentence here is fixed per kind or state; none is
 * written by a model. Pure, so the counts and words are tested here.
 */
import type { AttentionItem, AttentionKind } from "@/payments/attention";
import type { InboxProject, InboxView, ItemMoney } from "@/payments/inbox-view";
import type { MoneyEvent } from "@/payments/money-events";
import type { MoneyPart } from "../money/desk-view";

export type Bucket = "confirm" | "credit" | "holds" | "paypal";
export type SourceFilter = "all" | "live" | "example";

/** The four tiles, each the kinds of to-do it groups. */
export const BUCKET_OF: Record<AttentionKind, Bucket> = {
  not_ordered: "confirm", capture_ready: "confirm", awaiting_confirmation: "confirm",
  awaiting_credit: "credit",
  expiring: "holds", expired: "holds", renewal_failed: "holds",
  payment_unknown: "paypal", hold_failed: "paypal",
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  confirm: "Confirm the order, then charge", credit: "Record a credit, then refund", holds: "Holds ending", paypal: "Check with PayPal",
};

/** Why a kind of to-do needs the designer, said once above all its items. */
export const REASON: Record<AttentionKind, string> = {
  not_ordered: "Held past PayPal's 3-day honor period with no supplier order recorded, so capture is no longer assured: place each order, then record the supplier's confirmation.",
  capture_ready: "The supplier confirmed the order, so the confirmed amount can be charged. Capture is assured only in a hold's first 3 days.",
  awaiting_confirmation: "Held while the supplier checks the order: record the supplier's confirmation, then charge the confirmed amount.",
  awaiting_credit: "The return is agreed, and the refund waits for the supplier's credit: record the credit, then refund the client.",
  expiring: "PayPal holds last 29 days, and the supplier hasn't confirmed the order yet. With a saved payment method Setti renews the hold; without one, the client approves a new one.",
  expired: "The hold ended, so nothing is held for the item. Check PayPal, then hold it again or cancel the item.",
  renewal_failed: "Setti could not renew the hold with the client's saved payment method. Ask the client to approve a new hold before the current one ends, or cancel the item.",
  payment_unknown: "Setti has no settled PayPal result for the item's last step. Check its PayPal status before doing anything else with it.",
  hold_failed: "PayPal did not place the hold. Hold the item again, or cancel it.",
};

/** The project's main step, named after its most pressing kind. */
export const ACTION: Record<AttentionKind, string> = {
  not_ordered: "Record supplier confirmations", awaiting_confirmation: "Record supplier confirmations", capture_ready: "Charge confirmed items",
  awaiting_credit: "Record the supplier credit", expiring: "Review the holds", expired: "Review the holds", renewal_failed: "Review the holds",
  payment_unknown: "Check PayPal status", hold_failed: "Review the holds",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What to do, for one kind alone and as part of a longer list. */
const TODO: Record<AttentionKind, { alone: (n: number) => string; part: (n: number) => string }> = {
  not_ordered: { alone: (n) => `Order ${count(n, "held item")}, then record the ${n === 1 ? "confirmation" : "confirmations"}`, part: (n) => `order ${count(n, "held item")}` },
  capture_ready: { alone: (n) => `Charge ${count(n, "confirmed item")}`, part: (n) => `charge ${count(n, "item")}` },
  awaiting_confirmation: { alone: (n) => `Confirm ${count(n, "order")}, then charge`, part: (n) => `confirm ${count(n, "order")}` },
  awaiting_credit: { alone: (n) => `Record ${count(n, "credit")}, then refund`, part: (n) => `record ${count(n, "credit")}` },
  expiring: { alone: (n) => `${count(n, "hold")} ${n === 1 ? "ends" : "end"} within a week`, part: (n) => `${count(n, "hold")} ending` },
  expired: { alone: (n) => `Hold ${count(n, "item")} again, or cancel`, part: (n) => `${count(n, "hold")} expired` },
  renewal_failed: { alone: (n) => `Ask the client for ${count(n, "new hold")}`, part: (n) => `${count(n, "renewal")} failed` },
  payment_unknown: { alone: (n) => `Check ${count(n, "PayPal result")} first`, part: (n) => `check ${count(n, "PayPal result")}` },
  hold_failed: { alone: (n) => `Hold ${count(n, "item")} again, or cancel`, part: (n) => `${count(n, "hold")} failed` },
};

/** A project's to-dos by kind, most pressing kind first (the reminders come sorted). */
export function byKind(items: readonly AttentionItem[]): { kind: AttentionKind; items: AttentionItem[] }[] {
  const groups = new Map<AttentionKind, AttentionItem[]>();
  for (const item of items) groups.set(item.kind, [...groups.get(item.kind) ?? [], item]);
  return [...groups].map(([kind, entries]) => ({ kind, items: entries }));
}

/** "Confirm 3 orders, then charge"; with several kinds, "Record 1 credit, confirm 1 order". */
export function todo(items: readonly AttentionItem[]): string {
  const groups = byKind(items);
  if (groups.length === 1) return TODO[groups[0].kind].alone(groups[0].items.length);
  const text = groups.map((group) => TODO[group.kind].part(group.items.length)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const waiting = (items: readonly AttentionItem[], part: "held" | "toRefund") => items.reduce((sum, item) => sum + (item.amount.part === part ? item.amount.cents : 0), 0);
const matches = (source: SourceFilter, value: "live" | "example") => source === "all" || source === value;

export interface Tile { id: Bucket; label: string; count: number; projects: number; heldCents: number; toRefundCents: number; confirmed: boolean }

/** The four tiles over the reminders shown. */
export function tiles(reminders: readonly AttentionItem[]): Tile[] {
  return (Object.keys(BUCKET_LABEL) as Bucket[]).map((id) => {
    const items = reminders.filter((item) => BUCKET_OF[item.kind] === id);
    return {
      id, label: BUCKET_LABEL[id], count: items.length, projects: new Set(items.map((item) => item.projectKey)).size,
      heldCents: waiting(items, "held"), toRefundCents: waiting(items, "toRefund"), confirmed: items.some((item) => item.kind === "capture_ready"),
    };
  });
}

export interface ProjectRow extends InboxProject {
  /** The project's to-dos in the tile picked (all of them with none picked), most pressing first. */
  items: AttentionItem[];
  count: number;
  todo: string;
  heldCents: number;
  toRefundCents: number;
  /** Shares of the widest Waiting among the rows shown, for the bar. */
  heldShare: number;
  toRefundShare: number;
  isNew: boolean;
  /** Everything a quick search finds the project by. */
  search: string;
}

/** Whether the grid shows a row: its source is picked and it has to-dos in the picked tile. */
export const rowShown = (row: Pick<ProjectRow, "source" | "count">, source: SourceFilter) => matches(source, row.source) && row.count > 0;

/** Projects with any to-do, one row each, worked out for the picked tile; the grid's filter hides the rest. */
export function projectRows(view: Pick<InboxView, "reminders" | "projects">, pick: { bucket: Bucket | null; source: SourceFilter }, fresh: ReadonlySet<string>): ProjectRow[] {
  const byProject = new Map<string, AttentionItem[]>();
  for (const item of view.reminders) byProject.set(item.projectKey, [...byProject.get(item.projectKey) ?? [], item]);
  const rows = [...byProject].map(([key, all]): ProjectRow => {
    const first = all[0];
    const project = view.projects.find((entry) => entry.id === key)
      ?? { id: key, name: first.projectName, source: first.source, stage: "", client: "", paymentsHref: first.href, chatHref: `/chats/${key}` };
    const items = pick.bucket ? all.filter((item) => BUCKET_OF[item.kind] === pick.bucket) : all;
    return {
      ...project, items, count: items.length, todo: items.length ? todo(items) : "",
      heldCents: waiting(items, "held"), toRefundCents: waiting(items, "toRefund"), heldShare: 0, toRefundShare: 0,
      isNew: items.some((item) => fresh.has(item.id)),
      search: [project.name, project.client, ...all.flatMap((item) => [item.itemLabel, item.supplier ?? ""])].join(" "),
    };
  });
  const scale = Math.max(1, ...rows.filter((row) => rowShown(row, pick.source)).map((row) => row.heldCents + row.toRefundCents));
  return rows.map((row) => ({ ...row, heldShare: row.heldCents / scale, toRefundShare: row.toRefundCents / scale }))
    .sort((a, b) => b.count - a.count || b.heldCents + b.toRefundCents - (a.heldCents + a.toRefundCents) || a.name.localeCompare(b.name));
}

export const sourceCounts = (projects: readonly InboxProject[]): Record<SourceFilter, number> =>
  ({ all: projects.length, live: projects.filter((p) => p.source === "live").length, example: projects.filter((p) => p.source === "example").length });

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** Whole dollars without ".00", for the grid's Waiting. */
export const shortUsd = (cents: number) => usd(cents).replace(/\.00$/u, "");
export const when = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/** "$2,210 to refund · $1,180 held". */
export function waitingText(heldCents: number, toRefundCents: number): string {
  return [toRefundCents ? `${shortUsd(toRefundCents)} to refund` : "", heldCents ? `${shortUsd(heldCents)} held` : ""].filter(Boolean).join(" · ") || "—";
}

export interface ItemRow extends ItemMoney {
  id: string;
  status: string;
  part: MoneyPart;
  /** The item's PayPal records, newest first. */
  events: MoneyEvent[];
  isNew: boolean;
}

/** Where an item stands, as its status pill says it. */
function itemState(item: ItemMoney): { status: string; part: MoneyPart; note: string } {
  if (item.heldCents > 0) return { status: item.holds > 1 ? `On hold · ${item.holds} holds` : "On hold", part: "held", note: "On hold, not charged. It is charged after the supplier confirms the order." };
  if (item.refundedCents > 0) return item.refundedCents >= item.chargedCents
    ? { status: "Refunded", part: "refunded", note: "Charged, then refunded to you through PayPal." }
    : { status: "Partly refunded", part: "refunded", note: "Charged, and partly refunded to you through PayPal." };
  if (item.chargedCents > 0) return { status: "Charged", part: "kept", note: "Charged through PayPal." };
  return { status: "Hold released", part: "notFunded", note: "The hold was released, so nothing is held or charged for it." };
}
export const itemNote = (item: ItemMoney) => itemState(item).note;

/** One row per item, on hold first, then by what was charged; an item is new when a record of it is. */
export function itemRows(view: Pick<InboxView, "items" | "events">, fresh: ReadonlySet<string>): ItemRow[] {
  return view.items.map((item, index): ItemRow => {
    const events = view.events.filter((event) => event.itemLabel === item.label);
    return { ...item, ...itemState(item), id: `${index}:${item.label}`, events, isNew: events.some((event) => fresh.has(event.id)) };
  }).sort((a, b) => b.heldCents - a.heldCents || b.chargedCents - a.chargedCents || a.label.localeCompare(b.label));
}

export const EVENT_VERB: Record<MoneyEvent["kind"], string> = { held: "Hold placed", charged: "Charged", released: "Hold released", refunded: "Refunded" };

/** How PayPal last confirmed a record, and whether it did. */
export function confirmation(checked: MoneyEvent["checked"]): { text: string; confirmed: boolean } {
  if (!checked) return { text: "Not confirmed by PayPal yet", confirmed: false };
  const how = checked.via === "webhook" ? "Confirmed by PayPal" : checked.via === "readback" ? "Checked with PayPal" : "Confirmed in PayPal's response";
  return { text: `${how} · ${when(checked.at)}${checked.status && checked.via !== "response" ? ` · PayPal says ${checked.status}` : ""}`, confirmed: true };
}

/** The newest time PayPal confirmed any record, and how. */
export function lastConfirmed(events: readonly MoneyEvent[]): NonNullable<MoneyEvent["checked"]> | null {
  return events.reduce<MoneyEvent["checked"]>((latest, event) => event.checked && (!latest || event.checked.at > latest.at) ? event.checked : latest, null);
}

export interface Batch { key: string; at: string; title: string; totalCents: number; names: string; confirmation: string }

const BATCH_NOUN: Record<MoneyEvent["kind"], [string, string]> = { held: ["hold placed", "holds placed"], charged: ["charge", "charges"], released: ["hold released", "holds released"], refunded: ["refund", "refunds"] };
/** Records of one kind this close together came from one step. */
const BATCH_GAP_MS = 10 * 60 * 1000;

/** New records grouped by kind and time, newest first: how many, how much, for what, and how PayPal confirmed them. */
export function newBatches(events: readonly MoneyEvent[]): Batch[] {
  const batches: MoneyEvent[][] = [];
  const open = new Map<MoneyEvent["kind"], MoneyEvent[]>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const current = open.get(event.kind);
    if (current && Date.parse(event.at) - Date.parse(current.at(-1)!.at) <= BATCH_GAP_MS) current.push(event);
    else { const next = [event]; batches.push(next); open.set(event.kind, next); }
  }
  return batches.reverse().map((batch) => {
    const latest = batch.at(-1)!;
    const labels = [...new Set(batch.map((event) => event.itemLabel))];
    const pushed = batch.filter((event) => event.checked?.via === "webhook").length, checked = batch.filter((event) => event.checked).length;
    const seen = lastConfirmed(batch);
    return {
      key: `${latest.kind}:${batch[0].id}`, at: latest.at,
      title: `${when(latest.at)} · ${batch.length} ${BATCH_NOUN[latest.kind][batch.length === 1 ? 0 : 1]}`,
      totalCents: batch.reduce((sum, event) => sum + event.amountCents, 0),
      names: labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`,
      confirmation: pushed === batch.length ? `Confirmed by PayPal at ${when(seen!.at)}.`
        : checked === batch.length ? `Checked with PayPal at ${when(seen!.at)}.`
          : checked ? `${checked} of ${batch.length} confirmed by PayPal.` : "Not confirmed by PayPal yet.",
    };
  });
}
