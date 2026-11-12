"use client";

import { Check, ChevronDown, Eye } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark } from "../BrandMark";

/**
 * The quote editor's frame, the same for a first V1 and for every later version,
 * laid out as the agreed editor plan: a 1160px working column (breadcrumbs,
 * Project info, Quote items) and, where the page is wide enough, a side column
 * for Terms, Total and reference material. On a narrower page the side column
 * follows below, Terms beside Total.
 */
export const CARD = "min-w-0 rounded-xl border border-[var(--line)] bg-white";

export function EditorLayout({ main, side, bar }: { main: ReactNode; side: ReactNode; bar: ReactNode }) {
  return <div className="@container min-w-0">
    <div className="grid items-start gap-3 @min-[1472px]:grid-cols-[1160px_minmax(300px,1fr)]">
      <div className="grid min-w-0 max-w-[1160px] content-start gap-3">{main}</div>
      <div className="grid min-w-0 max-w-[1160px] content-start gap-3 @min-[1472px]:sticky @min-[1472px]:top-0 @min-[1472px]:max-w-none">{side}</div>
    </div>
    {bar}
  </div>;
}

/** Terms and Total: side by side under the items on a narrower page, stacked in the side column on a wide one. */
export function SumRow({ children }: { children: ReactNode }) {
  return <div className="grid items-stretch gap-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @min-[1472px]:grid-cols-1">{children}</div>;
}

export function EditorCrumbs({ name, right }: { name: string; right?: ReactNode }) {
  return <div className="flex min-h-[31px] flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-[var(--muted)]">
    <span>Quotes</span><span aria-hidden>/</span><b className="font-semibold text-[var(--ink)]">{name}</b>
    {right && <span className="ml-auto inline-flex gap-1.5">{right}</span>}
  </div>;
}

export function ModuleTitle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return <button type="button" onClick={onToggle} aria-expanded={open} className="inline-flex items-center gap-2 text-[18px] font-bold tracking-[-0.01em]">
    <ChevronDown className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} />{children}
  </button>;
}

export function DraftedBySetti() {
  return <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-[9px] py-[3px] text-[12px] text-slate-600"><BrandMark className="h-[15px] w-[15px]" />Drafted by Setti from the chat</span>;
}

const small = "text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]";

/** Project info: the studio and the client, the project's name with its facts, and where this version stands. */
export function ProjectInfoCard({ open, onToggle, summary, badge, studio, client, title, meta, quote }: {
  open: boolean; onToggle: () => void; summary: string; badge?: ReactNode;
  studio: { name: string; person: string; note: string };
  client: ReactNode;
  title: ReactNode;
  meta: { label: string; value: ReactNode }[];
  quote: { version: string | number; status: string; sent?: boolean; note: string };
}) {
  return <section className={CARD} aria-label="Project info">
    <div className={`flex flex-wrap items-center gap-2.5 px-4 py-[11px] ${open ? "border-b border-[var(--line)]" : ""}`}>
      <ModuleTitle open={open} onToggle={onToggle}>Project info</ModuleTitle>
      {!open && <span className="text-[12px] text-[var(--muted)]">{summary}</span>}
      {open && badge}
    </div>
    {open && <>
      <div className="grid sm:grid-cols-2">
        <div className="grid grid-cols-[44px_minmax(0,1fr)] content-start items-center gap-x-3 gap-y-0.5 px-4 py-3.5">
          <BrandMark className="row-span-3 h-11 w-11" />
          <b className="text-[14px] font-bold">{studio.name}</b>
          <span className="text-[12.5px]">{studio.person}</span>
          <span className="text-[12.5px] text-[var(--muted)]">{studio.note}</span>
        </div>
        <div className="grid content-start gap-0.5 border-t border-[var(--line)] px-4 py-3.5 sm:border-l sm:border-t-0"><small className={small}>Client</small>{client}</div>
      </div>
      <div className="flex flex-wrap items-end gap-x-[26px] gap-y-2.5 border-t border-[var(--line)] px-4 py-3.5">
        <h2 className="text-[21px] font-bold tracking-[-0.01em]">{title}</h2>
        <span className="flex-1" />
        {meta.map((fact) => <span key={fact.label} className="grid gap-px"><small className={small.replace("tracking-[0.06em]", "tracking-[0.04em]")}>{fact.label}</small><b className="text-[12.5px] font-bold">{fact.value}</b></span>)}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-[var(--line)] px-4 py-2.5 text-[12.5px] text-[var(--muted)]">
        <span>Quote <b className="text-[var(--ink)]">V{quote.version}</b></span>
        <span className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold before:h-1.5 before:w-1.5 before:rounded-full before:bg-current before:opacity-60 ${quote.sent ? "bg-emerald-50 text-emerald-700" : "bg-[#efede6] text-[#4b5348]"}`}>{quote.status}</span>
        <span>{quote.note}</span>
      </div>
    </>}
  </section>;
}

export const TOOL = "inline-flex items-center gap-[5px] whitespace-nowrap rounded-[7px] px-2 py-[5px] text-[12px] font-semibold text-[var(--ink)] hover:bg-[var(--canvas)] disabled:cursor-not-allowed disabled:bg-transparent disabled:text-[#b5b1a4]";
export const SELECT = "rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-[12px] text-[var(--ink)]";
export const GHOST = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--line)] bg-white px-[11px] py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]";

export function PreviewButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[var(--ink)] px-3 py-[7px] text-[12px] font-semibold text-white hover:bg-[#1f241d] disabled:opacity-40"><Eye className="h-[15px] w-[15px]" />Preview</button>;
}

/** Quote items: its title, the toolbar, then the table, edge to edge in the card. */
export function ItemsCard({ open, onToggle, summary, tools, children }: { open: boolean; onToggle: () => void; summary: string; tools: ReactNode; children: ReactNode }) {
  return <section className={CARD} aria-label="Quote items">
    <div className={`flex flex-wrap items-center gap-2.5 px-4 ${open ? "pb-0.5 pt-3.5" : "py-[11px]"}`}>
      <ModuleTitle open={open} onToggle={onToggle}>Quote items</ModuleTitle>
      {!open && <span className="text-[12px] text-[var(--muted)]">{summary}</span>}
    </div>
    {open && <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-[var(--line)] px-3 py-[9px]">{tools}</div>
      {children}
    </>}
  </section>;
}

export function SumCard({ label, first = false, children }: { label: string; first?: boolean; children: ReactNode }) {
  // In the side column the Total comes first, above the longer terms.
  return <section className={`${CARD} grid min-h-[230px] content-start px-5 pb-5 pt-[18px] ${first ? "@min-[1472px]:order-first" : ""}`} aria-label={label}>{children}</section>;
}

/** The bar along the bottom: what is left to do, the saved state and the actions. */
export function SendBar({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 z-10 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--line)] bg-white/[.96] px-4 py-2.5 backdrop-blur-[6px]">{children}</div>;
}

export function Todo({ done, children }: { done: boolean; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] ${done ? "border-emerald-700 bg-emerald-700 text-white" : "border-[#c9c4b4]"}`}>{done && <Check className="h-[9px] w-[9px]" strokeWidth={3.2} />}</span>{children}</span>;
}

export const SEND = "inline-flex items-center gap-[7px] whitespace-nowrap rounded-lg bg-[var(--primary-fill)] px-3.5 py-[9px] text-[12.5px] font-semibold text-[var(--on-primary)] hover:brightness-95 disabled:cursor-not-allowed disabled:bg-[#e6e3da] disabled:text-[var(--muted)] disabled:hover:brightness-100";
