"use client";

import { Bot, Inbox as InboxIcon, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InboxSummary } from "@/ai/inbox-summary";
import type { InboxView } from "@/payments/inbox-view";
import { AiTag } from "../chat/ChatMessageBubble";
import { part, type MoneyPart } from "../money/desk-view";
import { pricingTheme } from "../pricing/common";

/** The repo's grid theme, with the inbox's selected row and total row. */
export const inboxTheme = pricingTheme.withParams({ headerTextColor: "#475569", rowHoverColor: "#f7f6f2", selectedRowBackgroundColor: "#fffaf0", pinnedRowBackgroundColor: "#f7f6f2" });

export const CARD = "min-w-0 rounded-xl border border-[var(--line)] bg-white p-4";
export const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-1";

/** The inbox's page: its header, an error that keeps what was shown, and the body. */
export function InboxFrame({ subtitle, tools, error, children }: { subtitle: string; tools?: ReactNode; error?: string | null; children: ReactNode }) {
  return <section aria-labelledby="inbox-title" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-white">
    <header className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] px-5 py-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700"><InboxIcon className="h-4 w-4" /></span>
      <div className="mr-auto min-w-0">
        <h1 id="inbox-title" className="text-[15px] font-semibold">Inbox</h1>
        <p className="text-[11px] text-[var(--muted)]">{subtitle}</p>
      </div>
      {tools}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
      {error && <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
      {children}
    </div>
  </section>;
}

export function Loading() {
  return <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Reading the payment records…</p>;
}

export function SimulatedDay({ days }: { days: number }) {
  return days > 0 ? <span title="Demo: worked out as if this many days had passed" className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">Simulated time · day {days}</span> : null;
}

export function NewMark() {
  return <span className="ml-1.5 inline-block rounded-full bg-red-50 px-1.5 py-px align-[1px] text-[9px] font-semibold uppercase tracking-wide text-red-700">New</span>;
}

export function Swatch({ id }: { id: MoneyPart }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: part(id).fill }} />;
}

export function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-red-500" : "bg-[#ebe9e2]"}`} />;
}

/** A number on top of the page; a tile that filters the grid is a toggle button. */
export function Tile({ mark, label, corner, value, note, hot = false, small = false, pressed, onClick }: {
  mark: ReactNode; label: string; corner?: string; value: string; note: string; hot?: boolean; small?: boolean; pressed?: boolean; onClick?: () => void;
}) {
  const body = <>
    <span className="flex min-w-0 items-center gap-2 text-[12px] font-semibold">{mark}<span className="min-w-0 truncate">{label}</span>{corner && <span className="ml-auto shrink-0 text-[11px] font-normal text-[var(--muted)]">{corner}</span>}</span>
    <span className={`block font-bold tracking-tight tabular-nums ${small ? "py-1 text-[16px]" : "text-[24px]"}`}>{value}</span>
    <span className="block text-[11px] text-[var(--muted)]">{note}</span>
  </>;
  const look = `col-span-12 grid min-w-0 content-start gap-1 rounded-xl border px-4 py-3.5 text-left sm:col-span-6 xl:col-span-3 ${hot ? "border-[#f5b4b4] bg-[#fff8f8]" : "border-[var(--line)] bg-white"}`;
  if (!onClick) return <div className={look}>{body}</div>;
  return <button type="button" aria-pressed={pressed} onClick={onClick} className={`${look} ${FOCUS} ${pressed ? "shadow-[inset_0_0_0_2px_var(--primary-fill)]" : "hover:border-[#e9c6c7]"}`}>{body}</button>;
}

export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 focus-within:border-brand-400">
    <Search aria-hidden className="h-3.5 w-3.5 text-[var(--muted)]" />
    <input type="search" aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} className="w-48 min-w-0 bg-transparent text-[12px] outline-none placeholder:text-[var(--muted)]" />
    {value && <button type="button" onClick={() => onChange("")} aria-label="Clear search" className={`rounded ${FOCUS}`}><X className="h-3 w-3" /></button>}
  </label>;
}

/** Setti's summary of the same records, written by the model and checked against them, three lines until opened. */
export function Summary({ view }: { view: InboxView }) {
  const [state, setState] = useState<{ summary: InboxSummary | null; reason: string | null } | "loading" | null>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  // A new summary is asked for only when what the inbox shows changes; the server caches one per set of facts.
  const shown = useMemo(() => JSON.stringify(view.role === "designer" ? view.reminders.map((item) => [item.id, item.detail]) : view.events.map((event) => event.id)), [view]);
  const empty = view.role === "designer" ? !view.reminders.length : !view.events.length;
  useEffect(() => {
    if (empty) { setState(null); return; }
    let live = true;
    setState("loading");
    fetch("/api/inbox/summary", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ summary: InboxSummary | null; reason: string | null }> : { summary: null, reason: "Setti's summary is not available right now." })
      .then((body) => { if (live) setState(body); })
      .catch(() => { if (live) setState({ summary: null, reason: "Setti's summary is not available right now." }); });
    return () => { live = false; };
  }, [shown, empty]);
  const summary = state && state !== "loading" ? state.summary : null;
  const sentences = summary ? summary.sentences.map((sentence) => sentence.text).join(" ") : null;
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || open) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [sentences, open]);
  if (!state) return null;
  return <section aria-label="Setti's summary" className="min-w-0 rounded-xl bg-[var(--agent)] px-4 py-3">
    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-700"><Bot className="h-3.5 w-3.5" />Setti<AiTag /></p>
    {state === "loading" ? <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-slate-600"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Reading {view.role === "designer" ? "your projects" : "your payment records"}…</p>
      : summary ? <>
        <p ref={text} id="inbox-summary-text" className={`mt-1 text-[13px] leading-relaxed text-[var(--ink)] ${open ? "" : "line-clamp-3"}`}>{sentences}</p>
        {(clamped || open) && <button type="button" aria-expanded={open} aria-controls="inbox-summary-text" onClick={() => setOpen((value) => !value)} className={`mt-1 rounded text-[11px] font-semibold text-brand-700 hover:underline ${FOCUS}`}>{open ? "Show less" : "Read all"}</button>}
        <p className="mt-1.5 text-[10px] text-[var(--muted)]">AI · {summary.model} · checked against the {view.role === "designer" ? "reminders" : "records"}</p>
      </> : <p className="mt-1 text-[11px] text-slate-600">{state.reason ?? "No summary yet."}</p>}
  </section>;
}
