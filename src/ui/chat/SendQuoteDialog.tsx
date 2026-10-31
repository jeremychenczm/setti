"use client";

import { FileText, LoaderCircle, LockKeyhole, SendHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { QUOTE_MESSAGE_MAX } from "@/opening/types";
import { calculateQuoteTotals } from "@/quotes/totals";
import type { QuoteDocument } from "@/quotes/types";
import { usd } from "../demo-data";

function roomList(room: string): string {
  const rooms = room.split(" · ").map((name) => name.toLowerCase());
  return rooms.length > 1 ? `${rooms.slice(0, -1).join(", ")} and ${rooms.at(-1)}` : rooms[0] ?? "";
}

/** Previews V1 before the designer sends it; the server freezes its own copy of the same lines. */
export function SendQuoteDialog({ quote, clientName, onClose, onSend, onViewQuote }: {
  quote: QuoteDocument;
  clientName: string;
  onClose: () => void;
  /** Returns an error to show, or null once the quote is in the chat. */
  onSend: (id: string, text: string) => Promise<string | null>;
  onViewQuote: () => void;
}) {
  const totals = useMemo(() => calculateQuoteTotals(quote.lines), [quote]);
  const products = quote.lines.filter((line) => line.category === "furniture");
  const productSubtotal = calculateQuoteTotals(products).subtotalCents;
  const suppliers = new Set(products.map((line) => line.vendor)).size;
  const firstName = clientName.split(" ")[0];
  const [text, setText] = useState(`Hi ${firstName}, here is the full quote for ${quote.projectName}: ${totals.lineCount} items for the ${roomList(quote.room)}. Take a look and let me know if anything should change.`);
  // One id per send, kept across retries, so a lost response never posts the quote twice.
  const [sendId] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = text.trim().length > QUOTE_MESSAGE_MAX;

  async function send() {
    if (sending || !text.trim() || tooLong) return;
    setSending(true);
    setError(null);
    const failure = await onSend(sendId, text.trim());
    setSending(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="send-quote-title" className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/30 p-3 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--primary)]"><FileText className="h-4.5 w-4.5" /></span>
          <div className="min-w-0 flex-1"><h2 id="send-quote-title" className="text-[15px] font-semibold">Send quote V{quote.version}</h2><p className="mt-0.5 text-[12px] text-[var(--muted)]">To {clientName} · {quote.projectName}</p></div>
          <button onClick={onClose} disabled={sending} aria-label="Close" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)] disabled:opacity-50"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-xl bg-[var(--canvas)] p-4 text-[12px]">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{totals.lineCount} items · {products.length} products from {suppliers} supplier quotes, {totals.lineCount - products.length} services</span></div>
            <div className="space-y-1.5 text-slate-600">
              <Row label="Products" value={productSubtotal} />
              <Row label="Design services" value={totals.subtotalCents - productSubtotal} />
              <Row label="Tax" value={totals.taxCents} />
              <Row label="Delivery" value={totals.freightCents} />
              <div className="border-t border-slate-200 pt-2 text-[14px] font-semibold text-[var(--ink)]"><Row label="Quote total" value={totals.totalCents} /></div>
            </div>
            <button onClick={onViewQuote} disabled={sending} className="mt-3 text-[12px] font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Open the full quote</button>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium">Message to {firstName}</span>
            <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={sending} rows={4} className="w-full resize-y rounded-xl border border-[var(--line)] px-3 py-2.5 text-[13px] leading-relaxed outline-none focus:border-brand-200 disabled:opacity-60" />
            {tooLong && <span className="mt-1 block text-[11px] text-red-600">Keep the message under {QUOTE_MESSAGE_MAX.toLocaleString("en-US")} characters.</span>}
          </label>

          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--muted)]"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />Sending locks this version: {firstName} sees exactly these {totals.lineCount} lines and prices, in the chat and under Proposals. Nothing is charged. Payment comes only after the client confirms.</p>
          {error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button onClick={onClose} disabled={sending} className="rounded-lg px-3.5 py-2 text-[12px] font-medium text-slate-600 hover:bg-[var(--canvas)] disabled:opacity-50">Cancel</button>
          <button onClick={() => void send()} disabled={sending || !text.trim() || tooLong} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{sending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}{error ? "Retry sending" : "Send quote"}</button>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center justify-between gap-4"><span>{label}</span><span className="tabular-nums">{usd(value)}</span></div>;
}
