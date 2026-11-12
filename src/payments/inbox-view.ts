/**
 * The payment inbox in the sidebar. The designer's lists what needs doing
 * across every project (the reminders, the demo's examples included, with each
 * project as Money shows it); the client's shows where their money
 * stands in their project: every charge, hold, release and refund, each with the
 * last time PayPal confirmed it. Both are read from recorded facts; opening the
 * client's inbox first reads its newest records back from PayPal. The AI summary
 * on top is written from the same facts (`inboxFacts`). What the reader has not
 * seen yet is marked as new (`unread`), and the sidebar counts it (`inboxBadge`).
 */
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import { readLedger, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { SummaryFact } from "../ai/inbox-summary";
import { items } from "../db/schema";
import { moneyDesk } from "../money-desk/desk";
import { pricingCases } from "../pricing/schema";
import { and, eq } from "drizzle-orm";
import type { AttentionItem } from "./attention";
import { attentionView, sessionProjectName, type AttentionView } from "./attention-view";
import { lastInboxRead, markInboxSeen, unreadIds } from "./inbox-reads";
import { checkWithPayPal, moneyEvents, type MoneyEvent } from "./money-events";
import type { PayPalPayments } from "./paypal";

export interface InboxView {
  role: "designer" | "client";
  /** The reader's first name. */
  reader: string;
  simulatedDays: number;
  lastCheck: { at: string; problems: string[] } | null;
  /** The designer's held items with nothing to do yet; null for the client. */
  watching: AttentionView["watching"] | null;
  /** The designer's reminders across projects, most pressing first. */
  reminders: AttentionItem[];
  /** Every project the designer runs, as Money lists it; empty for the client. */
  projects: InboxProject[];
  /** The client's project and its money, newest first. */
  project: { key: CaseKey; name: string } | null;
  events: MoneyEvent[];
  totals: { heldCents: number; chargedCents: number; refundedCents: number } | null;
  /** Where each of the client's items stands now; empty for the designer. */
  items: ItemMoney[];
  /** When this view was read; opening the inbox marks records up to here as seen. */
  readAt: string;
  /** Events and reminders the reader had not seen when this view was read. */
  unread: string[];
  /** Whether the reader had opened the inbox before this view. */
  opened: boolean;
}

/** One item's money as it stands now; `holds` counts PayPal's holds standing for it. */
export interface ItemMoney { label: string; heldCents: number; chargedCents: number; refundedCents: number; releasedCents: number; holds: number }

/** One of the designer's projects: where it stands, and where its payments and chat are. */
export interface InboxProject { id: string; name: string; stage: string; client: string; paymentsHref: string; chatHref: string }

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const when = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/**
 * Where each item's money stands now, from PayPal's recorded results: what is
 * on hold, charged and refunded, and what an ended hold released. A hold's
 * money belongs to its item; a capture's to the item it charged.
 */
export function itemsNow(ledger: Pick<ProjectLedger, "authorizations" | "captures" | "refunds">, label: (itemId: string | null) => string, now = Date.now()): ItemMoney[] {
  const completed = ledger.captures.filter((capture) => capture.status === "completed");
  const capturedFrom = (holdId: string) => completed.filter((capture) => capture.authorizationId === holdId).reduce((sum, capture) => sum + capture.amountCents, 0);
  const byItem = new Map<string | null, ItemMoney>();
  const entry = (itemId: string | null) => {
    if (!byItem.has(itemId)) byItem.set(itemId, { label: label(itemId), heldCents: 0, chargedCents: 0, refundedCents: 0, releasedCents: 0, holds: 0 });
    return byItem.get(itemId)!;
  };
  for (const hold of ledger.authorizations) {
    const remaining = Math.max(0, hold.amountCents - capturedFrom(hold.id));
    const expired = hold.status === "expired" || (!!hold.expiresAt && hold.expiresAt.getTime() <= now);
    if ((hold.status === "created" || hold.status === "partially_captured") && !expired) {
      entry(hold.itemId).heldCents += remaining;
      if (remaining) entry(hold.itemId).holds += 1;
    } else if (remaining) entry(hold.itemId).releasedCents += remaining;
  }
  const holdItem = new Map(ledger.authorizations.map((hold) => [hold.id, hold.itemId]));
  const chargedItem = new Map(completed.map((capture) => [capture.id, capture.itemId ?? (capture.authorizationId ? holdItem.get(capture.authorizationId) : null) ?? null]));
  for (const capture of completed) entry(chargedItem.get(capture.id) ?? null).chargedCents += capture.amountCents;
  for (const refund of ledger.refunds.filter((record) => record.status === "completed")) entry(chargedItem.get(refund.captureId) ?? null).refundedCents += refund.amountCents;
  return [...byItem.values()].filter((item) => item.heldCents || item.chargedCents || item.refundedCents || item.releasedCents).sort((a, b) => a.label.localeCompare(b.label));
}

/** What is on hold, charged and refunded now in the client's project, in total and item by item. */
async function moneyNow(db: Pick<Db, "select">, sessionId: string, key: CaseKey) {
  const [row] = await db.select({ projectId: pricingCases.projectId }).from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
    .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  if (!row) return null;
  const ledger = await readLedger(db, row.projectId);
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.projectId, row.projectId))).map((entry) => [entry.id, entry.name]));
  const byItem = itemsNow(ledger, (itemId) => itemId ? names.get(itemId) ?? "An item" : "Design services");
  const sum = (field: "heldCents" | "chargedCents" | "refundedCents") => byItem.reduce((total, item) => total + item[field], 0);
  return { totals: { heldCents: sum("heldCents"), chargedCents: sum("chargedCents"), refundedCents: sum("refundedCents") }, items: byItem };
}

/** The designer's projects as Money's desk reads them, with where each one's payments and chat open. */
async function studioProjects(db: Db, sessionId: string | null, account: DemoAccount): Promise<InboxProject[]> {
  // The inbox lists only this session's projects; the prepared examples have nothing to act on.
  return (await moneyDesk(db, sessionId, account)).projects.filter((project) => project.source === "live").map((project) => ({
    id: project.id, name: project.name, stage: project.stage, client: project.client, paymentsHref: project.href, chatHref: `/chats/${project.id}`,
  }));
}

/** `projects: false` leaves out the designer's project list, for callers that only count. */
export async function inboxView(db: Db, paypal: PayPalPayments | null, sessionId: string | null, account: DemoAccount, options: { projects?: boolean } = {}): Promise<InboxView> {
  // Real time, taken first: a record completed while the view is read stays new.
  const readAt = new Date().toISOString();
  const attention = await attentionView(db, sessionId, account);
  const read = sessionId ? await lastInboxRead(db, sessionId, account.id) : null;
  const base = { reader: account.name.split(" ")[0], simulatedDays: attention.simulatedDays, lastCheck: attention.lastCheck, readAt, opened: read !== null, watching: account.role === "designer" ? attention.watching : null };
  if (account.role === "designer") {
    const projects = options.projects === false ? [] : await studioProjects(db, sessionId, account);
    return { ...base, role: "designer", reminders: attention.items, projects, project: null, events: [], totals: null, items: [], unread: unreadIds(read, { events: [], reminders: attention.items }) };
  }
  const key = account.projectKey;
  if (!key || !sessionId || !canOpenProject(account, key)) return { ...base, role: "client", reminders: [], projects: [], project: null, events: [], totals: null, items: [], unread: [] };
  let events = await moneyEvents(db, sessionId, key);
  // The client sees what PayPal says now: the newest records are read back first.
  if (paypal && events.length) { await checkWithPayPal(db, paypal, events); events = await moneyEvents(db, sessionId, key); }
  const money = await moneyNow(db, sessionId, key);
  return { ...base, role: "client", reminders: [], projects: [], project: { key, name: await sessionProjectName(db, sessionId, key) }, events, totals: money?.totals ?? null, items: money?.items ?? [], unread: unreadIds(read, { events, reminders: [] }) };
}

/**
 * The reader opened the inbox read at `through`: its money records up to then,
 * and the designer's reminders open now, are no longer new.
 */
export async function markInboxOpened(db: Db, sessionId: string, account: DemoAccount, through: Date): Promise<void> {
  const reminderIds = account.role === "designer" ? (await attentionView(db, sessionId, account)).items.map((item) => item.id) : [];
  await markInboxSeen(db, sessionId, account.id, { through, reminderIds });
}

/**
 * The number on the sidebar's Inbox: what the reader has not seen yet, the
 * designer's new reminders or the client's new money records. Opening the inbox
 * clears it; a reminder stays in the inbox until it is handled.
 */
export async function inboxBadge(db: Db, sessionId: string | null, account: DemoAccount): Promise<{ count: number; role: InboxView["role"]; opened: boolean }> {
  const view = await inboxView(db, null, sessionId, account, { projects: false });
  return { role: view.role, count: view.unread.length, opened: view.opened };
}

const VERB: Record<MoneyEvent["kind"], string> = { charged: "charged", held: "put on hold", released: "hold released", refunded: "refunded" };

/** Up to five names, or three and how many more: the way the summary names a group of items. */
function listed(labels: readonly string[]): string {
  return labels.length <= 5 ? labels.join("; ") : `${labels.slice(0, 3).join("; ")}; and ${labels.length - 3} more`;
}

const REMINDER_STATE: Record<AttentionItem["kind"], string> = {
  payment_unknown: "with an unknown PayPal result", hold_failed: "whose hold failed", renewal_failed: "whose hold renewal failed",
  expired: "whose hold expired", capture_ready: "ready to capture", expiring: "whose hold expires soon", not_ordered: "not ordered yet",
};

/** Facts that count and name the items sharing a state, when there are at least two; none when one group would only repeat the total. */
function groupFacts(groups: Map<string, { text: (count: number) => string; labels: string[] }>, total: number): SummaryFact[] {
  const shared = [...groups].filter(([, group]) => group.labels.length > 1);
  if (shared.length === 1 && shared[0][1].labels.length === total) return [];
  return shared.map(([id, group]) => ({ id, text: `${group.text(group.labels.length)}: ${listed(group.labels)}.`, items: group.labels }));
}

/** One item's state today, as the summary's facts state it. */
function nowText(item: ItemMoney): string {
  const parts = [item.heldCents ? `${usd(item.heldCents)} on hold` : "nothing on hold"];
  if (item.chargedCents) parts.push(`${usd(item.chargedCents)} charged`);
  if (item.refundedCents) parts.push(`${usd(item.refundedCents)} refunded`);
  if (item.releasedCents && !item.heldCents) parts.push(`an earlier ${usd(item.releasedCents)} hold was released`);
  return `Now · ${item.label}: ${parts.join("; ")}.`;
}

/**
 * The facts the inbox summary is written from: what the reader sees, without
 * times that change on every check. A client's facts say where each item stands
 * now ("Now ·") apart from the records that led there ("Earlier ·"), so a hold
 * that was later charged or released is never read as still standing.
 */
export function inboxFacts(view: InboxView): SummaryFact[] {
  if (view.role === "designer") {
    if (!view.reminders.length) return [];
    const today = view.reminders.filter((item) => item.urgency === "now").length;
    const labels = view.reminders.map((item) => item.itemLabel);
    const groups = new Map<string, { text: (count: number) => string; labels: string[] }>();
    for (const item of view.reminders) {
      const id = `group:${item.projectKey}:${item.kind}`;
      if (!groups.has(id)) groups.set(id, { text: (count) => `${item.projectName} · ${count} items ${REMINDER_STATE[item.kind]}`, labels: [] });
      groups.get(id)!.labels.push(item.itemLabel);
    }
    return [
      { id: "reminders", text: `${view.reminders.length} reminder${view.reminders.length === 1 ? "" : "s"} across ${new Set(view.reminders.map((item) => item.projectName)).size} project(s); ${today} to handle today. They are for ${listed(labels)}.`, items: labels },
      ...groupFacts(groups, view.reminders.length),
      ...view.reminders.slice(0, 20).map((item) => ({ id: item.id, text: `${item.projectName} · ${item.title}. ${item.detail}`, items: [item.itemLabel] })),
    ];
  }
  if (!view.events.length || !view.totals) return [];
  const groups = new Map<string, { text: (count: number) => string; labels: string[] }>([
    ["group-on-hold", { text: (count) => `Now · ${count} items on hold`, labels: view.items.filter((item) => item.heldCents > 0).map((item) => item.label) }],
    ["group-charged", { text: (count) => `Now · ${count} items charged, with nothing on hold`, labels: view.items.filter((item) => item.heldCents === 0 && item.chargedCents > 0).map((item) => item.label) }],
  ]);
  return [
    { id: "money-now", text: `In ${view.project?.name ?? "this project"}: ${usd(view.totals.chargedCents)} charged in total, ${usd(view.totals.heldCents)} on hold now, ${usd(view.totals.refundedCents)} refunded in total.` },
    ...groupFacts(groups, view.items.length),
    ...view.items.slice(0, 30).map((item, index) => ({ id: `now-${index + 1}`, text: nowText(item), items: [item.label] })),
    ...view.events.slice(0, 20).map((event) => ({ id: event.id, text: `Earlier · ${when(event.at)} · ${event.itemLabel}: ${usd(event.amountCents)} ${VERB[event.kind]}.`, items: [event.itemLabel] })),
  ];
}
