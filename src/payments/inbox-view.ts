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
import { readLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import { caseDocument } from "../chat/cases";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import type { SummaryFact } from "../ai/inbox-summary";
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
  /** When this view was read; opening the inbox marks records up to here as seen. */
  readAt: string;
  /** Events and reminders the reader had not seen when this view was read. */
  unread: string[];
  /** Whether the reader had opened the inbox before this view. */
  opened: boolean;
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

/** What is on hold, charged and refunded now in the client's project, from PayPal's recorded results. */
async function moneyNow(db: Pick<Db, "select">, sessionId: string, key: CaseKey) {
  const [row] = await db.select({ projectId: pricingCases.projectId }).from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
    .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  if (!row) return null;
  const ledger = await readLedger(db, row.projectId);
  const completed = ledger.captures.filter((capture) => capture.status === "completed");
  const heldCents = ledger.authorizations.filter((hold) => (hold.status === "created" || hold.status === "partially_captured") && !(hold.expiresAt && hold.expiresAt.getTime() <= Date.now()))
    .reduce((total, hold) => total + Math.max(0, hold.amountCents - completed.filter((capture) => capture.authorizationId === hold.id).reduce((sum, capture) => sum + capture.amountCents, 0)), 0);
  return {
    heldCents, chargedCents: completed.reduce((total, capture) => total + capture.amountCents, 0),
    refundedCents: ledger.refunds.filter((refund) => refund.status === "completed").reduce((total, refund) => total + refund.amountCents, 0),
  };
}

export async function inboxView(db: Db, paypal: PayPalPayments | null, sessionId: string | null, account: DemoAccount): Promise<InboxView> {
  // Real time, taken first: a record completed while the view is read stays new.
  const readAt = new Date().toISOString();
  const attention = await attentionView(db, sessionId, account);
  const read = sessionId ? await lastInboxRead(db, sessionId, account.id) : null;
  const base = { reader: account.name.split(" ")[0], simulatedDays: attention.simulatedDays, lastCheck: attention.lastCheck, readAt, opened: read !== null };
  if (account.role === "designer") return { ...base, role: "designer", reminders: attention.items, project: null, events: [], totals: null, unread: unreadIds(read, { events: [], reminders: attention.items }) };
  const key = account.projectKey;
  if (!key || !sessionId || !canOpenProject(account, key)) return { ...base, role: "client", reminders: [], project: null, events: [], totals: null, unread: [] };
  let events = await moneyEvents(db, sessionId, key);
  // The client sees what PayPal says now: the newest records are read back first.
  if (paypal && events.length) { await checkWithPayPal(db, paypal, events); events = await moneyEvents(db, sessionId, key); }
  return { ...base, role: "client", reminders: [], project: { key, name: caseDocument(key).projectName }, events, totals: await moneyNow(db, sessionId, key), unread: unreadIds(read, { events, reminders: [] }) };
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

/** The facts the inbox summary is written from: what the reader sees, without times that change on every check. */
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
    ...view.events.slice(0, 20).map((event) => ({ id: event.id, text: `${event.itemLabel}: ${usd(event.amountCents)} ${VERB[event.kind]} on ${day(event.at)}.` })),
  ];
}
