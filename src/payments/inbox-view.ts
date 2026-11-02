/**
 * The payment inbox in the sidebar. The designer's lists what needs doing
 * across every project (the reminders); the client's shows where their money
 * stands in their project: every charge, hold, release and refund, each with the
 * last time PayPal confirmed it. Both are read from recorded facts; opening the
 * client's inbox first reads its newest records back from PayPal. The AI summary
 * on top is written from the same facts (`inboxFacts`).
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
  const attention = await attentionView(db, sessionId, account);
  const base = { reader: account.name.split(" ")[0], simulatedDays: attention.simulatedDays, lastCheck: attention.lastCheck };
  if (account.role === "designer") return { ...base, role: "designer", reminders: attention.items, project: null, events: [], totals: null };
  const key = account.projectKey;
  if (!key || !sessionId || !canOpenProject(account, key)) return { ...base, role: "client", reminders: [], project: null, events: [], totals: null };
  let events = await moneyEvents(db, sessionId, key);
  // The client sees what PayPal says now: the newest records are read back first.
  if (paypal && events.length) { await checkWithPayPal(db, paypal, events); events = await moneyEvents(db, sessionId, key); }
  return { ...base, role: "client", reminders: [], project: { key, name: caseDocument(key).projectName }, events, totals: await moneyNow(db, sessionId, key) };
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
