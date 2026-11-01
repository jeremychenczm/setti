"use client";

import { ChevronDown, History } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CaseMessage } from "@/chat/types";
import { recordHeadline } from "./activity";
import { timeLabel } from "./ChatMessageBubble";

/**
 * Records saved in a row (signatures, PayPal results, supplier confirmations) as
 * one card between the messages: the latest one shows, the rest open on demand.
 */
export function ActivityCard({ records, highlightedId }: { records: CaseMessage[]; highlightedId: string | null }) {
  const details = useRef<HTMLDetailsElement>(null);
  const highlighted = records.some((record) => record.id === highlightedId);
  // A record linked from elsewhere opens its card; closing it again is the reader's choice.
  useEffect(() => { if (highlighted && details.current) details.current.open = true; }, [highlighted]);
  const latest = records.at(-1)!;
  const icon = <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--canvas)] text-slate-500"><History className="h-3.5 w-3.5" /></span>;
  const row = (record: CaseMessage) => <div id={`case-message-${record.id}`} className={`scroll-mt-5 rounded-lg transition-colors ${record.id === highlightedId ? "bg-yellow-50 ring-2 ring-yellow-200" : ""}`}>
    <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-600">{record.text}</p>
    <time dateTime={record.createdAt} className="text-[10px] text-[var(--muted)]">{timeLabel(record.createdAt)}</time>
  </div>;

  if (records.length === 1) return <div className="flex items-start gap-2.5 rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5">{icon}<div className="min-w-0 flex-1"><div className="mb-0.5 text-[10px] font-medium text-[var(--muted)]">Project activity</div>{row(latest)}</div></div>;

  return <details ref={details} className="group rounded-xl border border-[var(--line)] bg-white">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-[var(--ink)]">Project activity · {records.length} updates</span>
        <span className="block truncate text-[11px] text-[var(--muted)]">Latest: {recordHeadline(latest.text)}</span>
      </span>
      <time dateTime={latest.createdAt} className="shrink-0 text-[10px] text-[var(--muted)]">{timeLabel(latest.createdAt)}</time>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)] transition-transform group-open:rotate-180" />
    </summary>
    <ol className="space-y-2.5 border-t border-[var(--line)] px-3.5 py-3 pl-[52px]">{records.map((record) => <li key={record.id}>{row(record)}</li>)}</ol>
  </details>;
}
