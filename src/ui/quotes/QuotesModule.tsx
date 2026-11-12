"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseSnapshot, SentVersion } from "@/chat/types";
import { quoteHref } from "@/quotes/links";
import { changeOrderStatusLabel } from "../pricing/changeOrderStatus";
import { shortMoney } from "../pricing/common";
import { QuoteBoard } from "./QuoteBoard";
import type { QuoteOption } from "./QuoteReport";

const loading = () => <section className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-white text-[12px] text-[var(--muted)] shadow-sm"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Loading the quote…</section>;
const PricingWorkspaceView = dynamic(() => import("../pricing/PricingWorkspaceView").then((m) => m.PricingWorkspaceView), { loading });
const ChangeOrderPage = dynamic(() => import("../pricing/ChangeOrderPage").then((m) => m.ChangeOrderPage), { loading });

interface Versions { sent: SentVersion[]; draftOpen: boolean }

/**
 * A project's Quotes, for the designer, or Proposals, for its client. One page
 * for every version: the designer edits the open draft here, and every sent
 * version opens here too, with its decision and payments. `version` picks one;
 * without it the page opens on the draft being edited, else the newest version.
 */
export function QuotesModule({ projectKey, studioName, clientName, viewer, demo, options, focusItemId, version: requested, onBack, onSelectQuote, onOpenChat }: {
  projectKey: CaseKey; studioName: string; clientName: string; viewer: DemoAccount; demo: boolean; options: QuoteOption[]; focusItemId?: string | null; version?: number | null;
  onBack: () => void; onSelectQuote: (id: CaseKey) => void; onOpenChat: () => void;
}) {
  const [versions, setVersions] = useState<Versions | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chat/${encodeURIComponent(projectKey)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<CaseSnapshot> : null)
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        const sent = [...(snapshot?.versions ?? [])].sort((a, b) => b.version - a.version);
        // A draft is open until a version was sent from it as it stands.
        setVersions({ sent, draftOpen: !!snapshot?.draft && !sent.some((entry) => entry.fromCurrentDraft) });
      })
      .catch(() => { if (!controller.signal.aborted) setVersions({ sent: [], draftOpen: false }); });
    return () => controller.abort();
  }, [projectKey]);

  if (!versions) return loading();
  const board = <QuoteBoard projectKey={projectKey} studioName={studioName} viewer={viewer} options={options} focusItemId={focusItemId} onBack={onBack} onSelectQuote={onSelectQuote} onOpenChat={onOpenChat} />;
  // A version number names a sent version; V1 stays on the quote board, which knows its line decisions.
  if (requested === 1) return board;
  const chosen = requested ? versions.sent.find((entry) => entry.version === requested) : undefined;
  if (!chosen && viewer.role === "designer" && versions.draftOpen) {
    return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label="Quote editor"><PricingWorkspaceView projectKey={projectKey} clientName={clientName} embedded /></section>;
  }
  const shown = chosen ?? versions.sent[0];
  if (shown) {
    const toolbar = <span className="mr-auto flex flex-wrap items-center gap-3 text-[12px] text-[var(--muted)]">{viewer.role === "designer" ? "Quotes" : "Proposals"} / <b className="font-semibold text-[var(--ink)]">{options.find((option) => option.key === projectKey)?.label ?? projectKey}</b>
      <VersionSwitch projectKey={projectKey} sent={versions.sent} shown={shown.version} draftVersion={viewer.role === "designer" && versions.draftOpen ? (versions.sent[0]?.version ?? 1) + 1 : null} /></span>;
    return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label={`Quote version ${shown.version}`}><ChangeOrderPage orderId={shown.id} account={viewer} demo={demo} studioName={studioName} embedded toolbar={toolbar} /></section>;
  }
  return board;
}

/** The project's versions, newest first: choosing one opens it on this page. */
function VersionSwitch({ projectKey, sent, shown, draftVersion }: { projectKey: CaseKey; sent: SentVersion[]; shown: number; draftVersion: number | null }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const current = sent.find((entry) => entry.version === shown);
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
  const row = "flex w-full justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--canvas)]";
  return <span ref={wrap} className="relative">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--canvas)]">
      Version <b className="font-semibold text-[var(--ink)]">V{shown}{current ? ` · ${changeOrderStatusLabel(current.status)}` : ""}</b><ChevronDown className="h-3.5 w-3.5" />
    </button>
    {open && <span role="listbox" aria-label="Versions" className="absolute left-0 top-[calc(100%+6px)] z-30 grid w-[320px] gap-0.5 rounded-xl border border-[var(--line)] bg-white p-2 shadow-lg">
      {draftVersion && <a role="option" aria-selected={false} href={quoteHref(projectKey)} className={row}><span><b>V{draftVersion}</b> · Draft<span className="block text-[11px] text-[var(--muted)]">Open the editor</span></span></a>}
      {sent.map((entry) => <a key={entry.id} role="option" aria-selected={entry.version === shown} href={quoteHref(projectKey, entry.version)} className={`${row} ${entry.version === shown ? "bg-[var(--primary-soft)]" : ""}`}>
        <span><b>V{entry.version}</b> · {changeOrderStatusLabel(entry.status)}<span className="block text-[11px] text-[var(--muted)]">Sent {day(entry.issuedAt)}</span></span><span className="tabular-nums">{shortMoney(entry.totalCents)}</span></a>)}
      <a role="option" aria-selected={false} href={quoteHref(projectKey, 1)} className={row}><span><b>V1</b> · First quote<span className="block text-[11px] text-[var(--muted)]">Its lines and decisions</span></span></a>
      <span className="mt-1 block border-t border-[var(--line)] px-2.5 pt-1.5 text-[10.5px] text-[var(--muted)]">Sent versions are frozen. Each opens with its decision and payments.</span>
    </span>}
  </span>;
}
