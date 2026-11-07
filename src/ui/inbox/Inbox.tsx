"use client";

import { AlarmClock, ArrowDownLeft, Bot, ChevronRight, CircleDollarSign, Inbox as InboxIcon, LoaderCircle, LockKeyhole, Unlock } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { InboxSummary } from "@/ai/inbox-summary";
import type { InboxView } from "@/payments/inbox-view";
import type { MoneyEvent } from "@/payments/money-events";
import { dateTime, money } from "../pricing/common";
import { INBOX_SEEN } from "../workspace/useInboxBadge";
import { LastCheck } from "./LastCheck";

const PAYMENT_CHANGED = "setti:payment-changed";

/** What the inbox showed is no longer new; the sidebar's number follows. */
async function markSeen(view: InboxView) {
  try {
    const response = await fetch("/api/inbox/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ through: view.readAt }) });
    if (response.ok) window.dispatchEvent(new Event(INBOX_SEEN));
  } catch { /* still new; the next visit marks it */ }
}

/**
 * The payment inbox. Setti watches every project's money: the designer sees
 * what needs doing today, the client sees where their money stands, each record
 * with when PayPal last confirmed it. Setti's summary on top is written by the
 * model from the same records and checked against them before it is shown.
 * Records the reader had not seen are marked New for as long as the inbox stays open.
 */
export function Inbox({ account }: { account: DemoAccount }) {
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/inbox", { cache: "no-store" });
      if (!response.ok) throw new Error(`The inbox could not be loaded (${response.status}).`);
      const next = await response.json() as InboxView;
      setView(next); setError(null);
      if (next.unread.length) setFresh((current) => new Set([...current, ...next.unread]));
      void markSeen(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The inbox could not be loaded."); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    window.addEventListener(PAYMENT_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener(PAYMENT_CHANGED, refresh); window.removeEventListener("focus", refresh); };
  }, [load]);

  return <section aria-labelledby="inbox-title" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-white">
    <header className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700"><InboxIcon className="h-4 w-4" /></span>
      <div className="mr-auto">
        <h1 id="inbox-title" className="text-[15px] font-semibold">Inbox</h1>
        <p className="text-[11px] text-[var(--muted)]">{account.role === "designer" ? "Setti watches the money in every project and tells you what needs you." : "Where your money stands, as PayPal records it."}</p>
      </div>
      {view && view.simulatedDays > 0 && <span title="Demo: worked out as if this many days had passed" className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">Simulated time · day {view.simulatedDays}</span>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {error && <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
      {!view ? <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Reading the payment records…</p> : <>
        <Summary view={view} />
        {view.role === "designer" ? <Reminders view={view} fresh={fresh} /> : <ClientMoney view={view} fresh={fresh} />}
      </>}
    </div>
  </section>;
}

/** Setti's summary of the same records, written by the model and checked against them. */
function Summary({ view }: { view: InboxView }) {
  const [state, setState] = useState<{ summary: InboxSummary | null; reason: string | null } | "loading" | null>(null);
  // A new summary is asked for only when what the inbox shows changes; the server caches one per set of facts.
  const shown = useMemo(() => JSON.stringify(view.role === "designer" ? view.reminders.map((item) => [item.id, item.detail]) : view.events.map((event) => event.id)), [view]);
  const empty = view.role === "designer" ? !view.reminders.length : !view.events.length;
  useEffect(() => {
    if (empty) { setState(null); return; }
    let live = true;
    setState("loading");
    fetch("/api/inbox/summary", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ summary: InboxSummary | null; reason: string | null }> : { summary: null, reason: "Coordinator's summary is not available right now." })
      .then((body) => { if (live) setState(body); })
      .catch(() => { if (live) setState({ summary: null, reason: "Coordinator's summary is not available right now." }); });
    return () => { live = false; };
  }, [shown, empty]);
  if (!state) return null;
  return <div className="mb-4 rounded-xl bg-[var(--agent)] px-4 py-3">
    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700"><Bot className="h-3.5 w-3.5" />Coordinator</p>
    {state === "loading" ? <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-slate-600"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Reading {view.role === "designer" ? "your projects" : "your payment records"}…</p>
      : state.summary ? <>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink)]">{state.summary.sentences.map((sentence) => sentence.text).join(" ")}</p>
        <p className="mt-1.5 text-[10px] text-[var(--muted)]">AI · {state.summary.model} · checked against the records below</p>
      </> : <p className="mt-1 text-[11px] text-slate-600">{state.reason ?? "No summary yet."}</p>}
  </div>;
}

function NewMark() {
  return <span className="ml-1.5 inline-block rounded-full bg-red-50 px-1.5 py-px align-[1px] text-[9px] font-semibold uppercase tracking-wide text-red-700">New</span>;
}

function Reminders({ view, fresh }: { view: InboxView; fresh: ReadonlySet<string> }) {
  return <section aria-labelledby="needs-you">
    <h2 id="needs-you" className="flex items-center gap-1.5 text-[12px] font-semibold"><AlarmClock className="h-3.5 w-3.5 text-[var(--primary)]" />Needs you today
      {view.reminders.length > 0 && <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">{view.reminders.length}</span>}</h2>
    <div className="-mx-2"><LastCheck check={view.lastCheck} /></div>
    {view.reminders.length === 0 ? <p className="mt-3 text-[12px] text-[var(--muted)]">Nothing needs you today. Setti checks every project&apos;s holds, charges and refunds and lists here what needs your attention.</p>
      : <ul className="mt-3 space-y-2">{view.reminders.map((item) => <li key={item.id}>
        <a href={item.href} className="group flex items-start gap-3 rounded-xl border border-[var(--line)] px-4 py-3 hover:border-brand-200 hover:bg-brand-50/40">
          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.urgency === "now" ? "bg-red-500" : "bg-amber-400"}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-[var(--ink)]">{item.title}{fresh.has(item.id) && <NewMark />}</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-600">{item.detail}</span>
            <span className="mt-1 block text-[10px] text-[var(--muted)]">{item.projectName}</span>
          </span>
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-brand-700 group-hover:underline">Open<ChevronRight className="h-3.5 w-3.5" /></span>
        </a>
      </li>)}</ul>}
  </section>;
}

const EVENT = {
  charged: { icon: CircleDollarSign, verb: "Charged", tone: "text-emerald-700" },
  held: { icon: LockKeyhole, verb: "On hold", tone: "text-brand-700" },
  released: { icon: Unlock, verb: "Hold released", tone: "text-slate-600" },
  refunded: { icon: ArrowDownLeft, verb: "Refunded", tone: "text-emerald-700" },
} as const;

function ClientMoney({ view, fresh }: { view: InboxView; fresh: ReadonlySet<string> }) {
  if (!view.project) return <p className="text-[12px] text-[var(--muted)]">No project is linked to this account.</p>;
  return <section aria-labelledby="your-money">
    <h2 id="your-money" className="text-[12px] font-semibold">Your money · {view.project.name}</h2>
    {view.totals && <div className="mt-2 grid grid-cols-3 gap-2">{[
      { label: "Charged", cents: view.totals.chargedCents }, { label: "On hold now", cents: view.totals.heldCents }, { label: "Refunded", cents: view.totals.refundedCents },
    ].map((tile) => <div key={tile.label} className="rounded-lg bg-[var(--canvas)] p-2.5"><p className="text-[10px] text-[var(--muted)]">{tile.label}</p><p className="mt-0.5 text-[15px] font-semibold tabular-nums">{money(tile.cents)}</p></div>)}</div>}
    {view.events.length === 0 ? <p className="mt-3 text-[12px] text-[var(--muted)]">Nothing has been charged or held yet.</p>
      : <ol className="mt-3 divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">{view.events.map((event) => <EventRow key={event.id} event={event} isNew={fresh.has(event.id)} />)}</ol>}
  </section>;
}

function EventRow({ event, isNew }: { event: MoneyEvent; isNew: boolean }) {
  const { icon: Icon, verb, tone } = EVENT[event.kind];
  return <li className="flex items-start gap-3 px-4 py-3">
    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
    <div className="min-w-0 flex-1">
      <p className="text-[13px]"><span className="font-medium">{event.itemLabel}</span> · <span className={tone}>{verb}</span> <span className="tabular-nums">{money(event.amountCents)}</span>{isNew && <NewMark />}</p>
      <p className="mt-0.5 text-[10px] text-[var(--muted)]">{dateTime(event.at)}{event.paypalId ? <> · PayPal <span className="font-mono">{event.paypalId}</span></> : null}</p>
      <p className="mt-0.5 text-[10px] text-slate-500">{event.checked
        ? `${event.checked.via === "webhook" ? "Confirmed by PayPal" : event.checked.via === "readback" ? "Checked with PayPal" : "Confirmed in PayPal's response"} · ${dateTime(event.checked.at)}${event.checked.status && event.checked.via !== "response" ? ` · PayPal says ${event.checked.status}` : ""}`
        : "Not confirmed by PayPal yet"}</p>
    </div>
  </li>;
}
