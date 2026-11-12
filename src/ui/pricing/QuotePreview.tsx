"use client";

import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ChangeOrderSummary } from "@/pricing/types";
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { VersionReceipt } from "@/receipts/types";
import { ReceiptDocument } from "../receipts/ReceiptDocument";
import { useVersionReceipt } from "../receipts/useVersionReceipt";
import { changeOrderStatusLabel } from "./changeOrderStatus";
import { shortMoney } from "./common";

const STATUS_NOTE: Record<VersionReceipt["version"]["status"], string> = {
  draft: "Draft, not sent", awaiting_signature: "Sent, awaiting signature", approved: "Signed", partly_approved: "Signed in part",
  declined: "Declined", changes_requested: "Returned for changes", superseded: "Replaced before it was signed",
};

/**
 * A version's formal quote in the middle of the page, on A4 sheets: the same
 * document the client reads. Escape, Close or the dimmed page around it close it.
 */
export function QuotePreview({ receipt, onClose }: { receipt: VersionReceipt; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, [onClose]);
  const draft = receipt.version.status === "draft";
  return <div role="dialog" aria-modal="true" aria-label={`Quote version ${receipt.version.number}`} className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(36,38,32,0.66)] px-4 pb-12 pt-3"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sticky top-0 z-10 mx-auto mb-4 flex max-w-[820px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-[var(--ink)] px-4 py-2.5 text-[12.5px] text-white">
      <b className="text-[13.5px]">{draft ? "Preview · " : ""}Quote V{receipt.version.number}</b>
      <span className="text-white/70">{STATUS_NOTE[receipt.version.status]} · A4{draft ? " · what the client receives" : ""}</span>
      <button ref={close} type="button" onClick={onClose} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-white/35 px-3 py-1 text-[12px] font-semibold hover:bg-white/10"><X className="h-3.5 w-3.5" />Close</button>
    </div>
    <div className="mx-auto w-full max-w-[820px]" onMouseDown={(event) => event.stopPropagation()}>
      <ReceiptDocument receipt={receipt} embedded />
    </div>
  </div>;
}

/** An earlier version's formal quote, loaded from its record. */
function SavedVersion({ projectKey, version, onClose }: { projectKey: CaseKey; version: number; onClose: () => void }) {
  const loaded = useVersionReceipt(projectKey, version);
  if (loaded && "receipt" in loaded) return <QuotePreview receipt={loaded.receipt} onClose={onClose} />;
  return <div role="dialog" aria-modal="true" aria-label={`Quote version ${version}`} className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(36,38,32,0.66)] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="flex items-center gap-3 rounded-xl bg-white px-5 py-4 text-[13px]">
      {!loaded ? <><LoaderCircle className="h-4 w-4 animate-spin" />Loading quote V{version}…</> : <><span className="text-red-800">{loaded.error}</span><button type="button" onClick={onClose} className="font-semibold underline">Close</button></>}
    </div>
  </div>;
}

/**
 * Every version of the project, newest first. The open draft is the one being
 * edited; choosing a sent version opens its formal quote over the page, with
 * the client's signature once signed. The list stays on the draft.
 */
export function VersionMenu({ projectKey, quote, orders, draftVersion }: { projectKey: CaseKey; quote: ApprovedQuoteReport; orders: ChangeOrderSummary[]; draftVersion: number | null }) {
  const [open, setOpen] = useState(false);
  const [showing, setShowing] = useState<number | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const sent = [...orders].sort((a, b) => b.version - a.version);
  const latest = draftVersion ?? sent[0]?.version ?? quote.version;
  const current = draftVersion ? "Draft" : sent[0] ? changeOrderStatusLabel(sent[0].status) : "Signed";
  const hasBaseline = !sent.some((order) => order.version === quote.version);
  return <span ref={wrap} className="relative inline-block">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={open} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--canvas)]">
      Version <b className="font-semibold text-[var(--ink)]">V{latest} · {current}</b><ChevronDown className="h-3.5 w-3.5" />
    </button>
    {open && <div role="listbox" aria-label="Versions" className="absolute right-0 top-[calc(100%+6px)] z-30 grid w-[320px] gap-0.5 rounded-xl border border-[var(--line)] bg-white p-2 shadow-lg">
      {draftVersion && <button role="option" aria-selected="true" type="button" onClick={() => setOpen(false)} className="flex justify-between gap-3 rounded-lg bg-[var(--primary-soft)] px-2.5 py-2 text-left text-[12px]">
        <span><b>V{draftVersion}</b> · Draft<span className="block text-[11px] text-[var(--muted)]">You are editing this version</span></span></button>}
      {sent.map((order) => <button key={order.id} role="option" aria-selected={!draftVersion && order === sent[0]} type="button" onClick={() => { setOpen(false); setShowing(order.version); }} className="flex justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-[var(--canvas)]">
        <span><b>V{order.version}</b> · {changeOrderStatusLabel(order.status)}<span className="block text-[11px] text-[var(--muted)]">Sent {new Date(order.issuedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })}</span></span>
        <span className="tabular-nums">{shortMoney(order.totalCents)}</span></button>)}
      {hasBaseline && <button role="option" aria-selected={false} type="button" onClick={() => { setOpen(false); setShowing(quote.version); }} className="flex justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-[var(--canvas)]">
        <span><b>V{quote.version}</b> · Signed<span className="block text-[11px] text-[var(--muted)]">Signed by {quote.approvedBy ?? quote.clientName}</span></span></button>}
      <p className="mt-1 border-t border-[var(--line)] px-2.5 pt-1.5 text-[10.5px] text-[var(--muted)]">Sent versions are frozen. Choosing one opens its formal quote, with the signature once signed.</p>
    </div>}
    {showing !== null && <SavedVersion projectKey={projectKey} version={showing} onClose={() => setShowing(null)} />}
  </span>;
}
