/**
 * The payment inbox in the sidebar. The designer's lists what needs doing
 * across every project (the reminders); the client's shows where their money
 * stands in their project: every charge, hold, release and refund, each with the
 * last time PayPal confirmed it. Both are read from recorded facts; opening the
 * client's inbox first reads its newest records back from PayPal. The AI summary
 * on top is written from the same facts (`inboxFacts`). What the reader has not
 * seen yet is marked as new (`unread`), and the sidebar counts it (`inboxBadge`).
 */
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import { readLedger, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import { caseDocument } from "../chat/cases";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { SummaryFact } from "../ai/inbox-summary";
import { items } from "../db/schema";
import { pricingCases } from "../pricing/schema";
import { and, eq } from "drizzle-orm";
import type { AttentionItem } from "./attention";
import { attentionView } from "./attention-view";
import { lastInboxRead, markInboxSeen, unreadIds } from "./inbox-reads";
import { checkWithPayPal, moneyEvents, type MoneyEvent } from "./money-events";
import type { PayPalPayments } from "./paypal";

export interface InboxView {
  role: "designer" | "client";
  /** The reader's first name. */
  reader: string;
  simulatedDays: number;
  lastCheck: { at: string; problems: string[] } | null;
  /** The designer's reminders across projects, most pressing first. */
  reminders: AttentionItem[];
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

/** One item's money as it stands now. */
export interface ItemMoney { label: string; heldCents: number; chargedCents: number; refundedCents: number; releasedCents: number }

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
    if (!byItem.has(itemId)) byItem.set(itemId, { label: label(itemId), heldCents: 0, chargedCents: 0, refundedCents: 0, releasedCents: 0 });
    return byItem.get(itemId)!;
  };
  for (const hold of ledger.authorizations) {
    const remaining = Math.max(0, hold.amountCents - capturedFrom(hold.id));
    const expired = hold.status === "expired" || (!!hold.expiresAt && hold.expiresAt.getTime() <= now);
    if ((hold.status === "created" || hold.status === "partially_captured") && !expired) entry(hold.itemId).heldCents += remaining;
    else if (remaining) entry(hold.itemId).releasedCents += remaining;
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

export async function inboxView(db: Db, paypal: PayPalPayments | null, sessionId: string | null, account: DemoAccount): Promise<InboxView> {
  // Real time, taken first: a record completed while the view is read stays new.
  const readAt = new Date().toISOString();
  const attention = await attentionView(db, sessionId, account);
  const read = sessionId ? await lastInboxRead(db, sessionId, account.id) : null;
  const base = { reader: account.name.split(" ")[0], simulatedDays: attention.simulatedDays, lastCheck: attention.lastCheck, readAt, opened: read !== null };
  if (account.role === "designer") return { ...base, role: "designer", reminders: attention.items, project: null, events: [], totals: null, items: [], unread: unreadIds(read, { events: [], reminders: attention.items }) };
  const key = account.projectKey;
  if (!key || !sessionId || !canOpenProject(account, key)) return { ...base, role: "client", reminders: [], project: null, events: [], totals: null, items: [], unread: [] };
  let events = await moneyEvents(db, sessionId, key);
  // The client sees what PayPal says now: the newest records are read back first.
  if (paypal && events.length) { await checkWithPayPal(db, paypal, events); events = await moneyEvents(db, sessionId, key); }
  const money = await moneyNow(db, sessionId, key);
  return { ...base, role: "client", reminders: [], project: { key, name: caseDocument(key).projectName }, events, totals: money?.totals ?? null, items: money?.items ?? [], unread: unreadIds(read, { events, reminders: [] }) };
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
 * The number on the sidebar's Inbox. The designer's counts the reminders still
 * open, read or not: they go away when handled, not when seen. The client's
 * counts money records completed since they last opened the inbox.
 */
export async function inboxBadge(db: Db, sessionId: string | null, account: DemoAccount): Promise<{ count: number; role: InboxView["role"]; opened: boolean }> {
  const view = await inboxView(db, null, sessionId, account);
  return { role: view.role, count: view.role === "designer" ? view.reminders.length : view.unread.length, opened: view.opened };
}

const VERB: Record<MoneyEvent["kind"], string> = { charged: "charged", held: "put on hold", released: "hold released", refunded: "refunded" };

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
    return [
      { id: "reminders", text: `${view.reminders.length} reminder${view.reminders.length === 1 ? "" : "s"} across ${new Set(view.reminders.map((item) => item.projectName)).size} project(s); ${today} to handle today.` },
      ...view.reminders.slice(0, 20).map((item) => ({ id: item.id, text: `${item.projectName} · ${item.title}. ${item.detail}` })),
    ];
  }
  if (!view.events.length || !view.totals) return [];
  return [
    { id: "money-now", text: `In ${view.project?.name ?? "this project"}: ${usd(view.totals.chargedCents)} charged in total, ${usd(view.totals.heldCents)} on hold now, ${usd(view.totals.refundedCents)} refunded in total.` },
    ...view.items.slice(0, 30).map((item, index) => ({ id: `now-${index + 1}`, text: nowText(item) })),
    ...view.events.slice(0, 20).map((event) => ({ id: event.id, text: `Earlier · ${when(event.at)} · ${event.itemLabel}: ${usd(event.amountCents)} ${VERB[event.kind]}.` })),
  ];
}
