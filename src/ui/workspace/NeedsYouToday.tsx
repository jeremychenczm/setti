"use client";

import { AlarmClock, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { AttentionItem } from "@/payments/attention";

const SHOWN = 3;
/** A daily check older than this has missed its run. */
const OVERDUE_MS = 36 * 60 * 60 * 1000;

const when = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** When the daily check last ran, said plainly when it is missing, late or could not check something. */
function LastCheck({ check }: { check: { at: string; problems: string[] } | null }) {
  const late = !check || Date.now() - new Date(check.at).getTime() > OVERDUE_MS;
  const text = !check ? "The daily check has not run yet."
    : check.problems.length ? `Last checked ${when(check.at)} · ${check.problems.length} could not be checked.`
      : `Last checked ${when(check.at)}${late ? " · overdue" : ""}`;
  return <p title={check?.problems.join(" · ") || undefined} className={`px-2 pt-0.5 text-[10px] ${late || check?.problems.length ? "text-amber-700" : "text-slate-400"}`}>{text}</p>;
}

/**
 * The studio's reminders above the chat list, most pressing first. Each one
 * opens the item where the designer acts on it. Worked out from recorded money
 * only; nothing here moves money.
 */
export function NeedsYouToday({ items, error, lastCheck = null }: { items: AttentionItem[] | null; error: string | null; lastCheck?: { at: string; problems: string[] } | null }) {
  const [all, setAll] = useState(false);
  if (!items) return error ? <p className="px-4 pb-1 pt-3 text-[11px] text-[var(--muted)]">{error}</p> : null;
  const shown = all ? items : items.slice(0, SHOWN);
  return <section aria-labelledby="needs-you-today" className="border-b border-[var(--line)] px-2 pb-2 pt-3">
    <h2 id="needs-you-today" className="flex items-center gap-1.5 px-2 text-[12px] font-semibold">
      <AlarmClock className="h-3.5 w-3.5 text-[var(--primary)]" />Needs you today
      {items.length > 0 && <span className="ml-auto rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">{items.length}</span>}
    </h2>
    <LastCheck check={lastCheck} />
    {items.length === 0
      ? <p className="px-2 pb-1 pt-1.5 text-[11px] text-[var(--muted)]">Nothing needs you today.</p>
      : <ul className={`mt-1.5 space-y-1 ${all ? "max-h-[45vh] overflow-y-auto" : ""}`}>{shown.map((item) => <li key={item.id}>
        <a href={item.href} className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--canvas)]">
          <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.urgency === "now" ? "bg-red-500" : "bg-amber-400"}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-medium text-[var(--ink)]">{item.title}</span>
            <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">{item.detail}</span>
            <span className="mt-0.5 block text-[10px] text-slate-400">{item.projectName}</span>
          </span>
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />
        </a>
      </li>)}</ul>}
    {items.length > SHOWN && <button type="button" onClick={() => setAll(!all)} className="mt-1 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium text-slate-600 hover:bg-[var(--canvas)]">
      <ChevronDown className={`h-3 w-3 transition-transform ${all ? "rotate-180" : ""}`} />{all ? "Show fewer" : `${items.length - SHOWN} more`}
    </button>}
  </section>;
}
