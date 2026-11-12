"use client";

import { Download, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CaseKey } from "@/chat/types";
import { clientSignatureName, type OpeningLine, type QuoteView } from "@/opening/types";
import { calculateLineTotals } from "@/quotes/totals";
import { ProjectPayments } from "../payments/ProjectPayments";
import { dateTime } from "../pricing/common";
import { ReceiptDocument } from "../receipts/ReceiptDocument";
import { useVersionReceipt } from "../receipts/useVersionReceipt";
import { FirstQuoteMoneyCard, firstQuoteMoney } from "./ClientFirstQuote";
import type { QuoteActions } from "./QuoteReport";

const cents = (value: number) => (value / 100).toFixed(2);
const cell = (value: string | number | undefined) => { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };

/** Every V1 line with its supplier details, which the formal quote leaves out for the client. */
function downloadCsv(view: QuoteView, lineOf: (itemId: string) => OpeningLine) {
  const quote = view.document;
  const head = ["Item", "Supplier", "Room", "SKU", "Specification", "Quantity", "Unit", "Unit price", "Tax", "Delivery", "Total", "Status", "Return policy", "Source", "Source URL"];
  const rows = quote.lines.map((line) => [line.name, line.vendor, line.room, line.sku, line.specification, line.quantity, line.unitLabel, cents(line.unitPriceCents), cents(line.taxCents), cents(line.freightCents),
    cents(calculateLineTotals(line).totalCents), view.approval ? "approved" : lineOf(line.itemId).state, line.returnPolicy, line.source.name ?? "", line.source.url ?? ""]);
  const text = [[`Setti | ${quote.projectName} | Quote V1`], head, ...rows].map((row) => row.map(cell).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = `Setti-${quote.projectName.replace(/[^a-zA-Z0-9]+/g, "-")}-Quote-V1.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * The designer's V1 once it is sent, laid out like the client's: the formal
 * quote beside the money and where V1 stands. While the client decides it shows
 * the tally; after, the signature. Lines the client declined or has not decided
 * can be revised in the next version or dropped. The payments follow below.
 */
export function DesignerFirstQuote({ projectKey, view, studioName, toolbar, actions, onOpenChat }: {
  projectKey: CaseKey; view: QuoteView; studioName: string; toolbar?: ReactNode; actions: QuoteActions; onOpenChat: () => void;
}) {
  const { document: quote, opening, approval } = view;
  const clientName = clientSignatureName(quote);
  const client = clientName.split(" ")[0] || "The client";
  const lineOf = (itemId: string): OpeningLine => view.lines[itemId] ?? { state: approval ? "approved" : "pending", note: null, decidedAt: null, by: null, questions: 0 };
  const open = !approval && !!opening.sentAt && !opening.closed;
  const waiting = open && opening.progress.pending > 0;
  const formal = useVersionReceipt(projectKey, 1, { refresh: `${opening.progress.approved}:${opening.progress.declined}:${opening.progress.withdrawn}:${opening.signedAt ?? ""}` });
  const money = firstQuoteMoney(quote, lineOf);
  const notAgreed = open ? quote.lines.filter((line) => ["declined", "pending"].includes(lineOf(line.itemId).state)) : [];
  const signed = approval ? { at: approval.approvedAt, by: approval.approvedBy, sample: true } : opening.signedAt ? { at: opening.signedAt, by: clientName, sample: false } : null;

  const [dropping, setDropping] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(itemId: string, act: (itemId: string) => Promise<string | null>) {
    setBusy(itemId); setError(null);
    const failure = await act(itemId);
    setBusy(null);
    if (failure) setError(failure); else setDropping(null);
  }

  const card = "rounded-xl border border-[var(--line)] bg-white";
  const fact = (label: string, value: ReactNode) => <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] py-2.5 text-[12.5px]"><dt className="text-[var(--muted)]">{label}</dt><dd className="m-0 text-right font-semibold">{value}</dd></div>;
  const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]";
  const buttons = <div className="mt-3 flex flex-wrap justify-end gap-2">
    <button type="button" onClick={() => downloadCsv(view, lineOf)} title="Every line with its supplier details" className={quiet}><Download className="h-3.5 w-3.5" />Download CSV</button>
    <button type="button" onClick={onOpenChat} className={quiet}>Open the project chat</button>
  </div>;

  return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label="Quote version 1">
    <div className="grid gap-4 pb-2 text-[var(--ink)]">
      <header className="flex flex-wrap items-center gap-3 rounded-xl bg-white px-4 py-2.5">{toolbar ?? <span className="text-[12px] text-[var(--muted)]">Quotes / <b className="font-semibold text-[var(--ink)]">{quote.projectName}</b></span>}</header>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4 lg:sticky lg:top-0 lg:col-start-2 lg:row-start-1">
          <FirstQuoteMoneyCard money={money} title={`${client}'s money`} aside={waiting ? "Approved so far" : "For the approved lines"}
            services={{ label: "Services", caption: `${client} pays in the payment steps below` }}
            products={{ label: "Products", caption: `Held on ${client}'s card, charged as each supplier confirms` }} />

          {waiting && <section className={`${card} p-5`} aria-labelledby="quote-status-title">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">Sent · {dateTime(opening.sentAt!)} PT</p>
            <h2 id="quote-status-title" className="mt-0.5 text-[15px] font-bold">Waiting for {client}</h2>
            <p className="mt-1 text-[12.5px] text-slate-600">{client} approves or declines each line on the quote, then signs. Undecided lines can wait.</p>
            <div className="mt-3 grid grid-cols-3 gap-2">{([["Approved", opening.progress.approved], ["Declined", opening.progress.declined], ["Undecided", opening.progress.pending]] as const).map(([label, count]) =>
              <div key={label} className="grid rounded-lg bg-[var(--canvas)] px-2.5 py-2"><span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">{label}</span><b className="text-[15px]">{count}</b></div>)}</div>
            {buttons}
          </section>}

          {!waiting && signed && <section className={`${card} p-5`} aria-labelledby="quote-status-title">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">{signed.sample ? "Approved" : "Signed"} · {dateTime(signed.at)} PT</p>
            <h2 id="quote-status-title" className="mt-0.5 text-[15px] font-bold">{signed.sample ? "V1 approved" : `${client} signed V1`}</h2>
            <dl className="mt-3 border-t border-[var(--line)]">
              {fact("Approved", `${opening.progress.approved || (approval ? quote.lines.length : 0)} of ${quote.lines.length} lines`)}
              {opening.progress.declined > 0 && fact("Declined", `${opening.progress.declined} ${opening.progress.declined === 1 ? "line" : "lines"}`)}
              {fact("Signed as", <span className="font-signature text-[20px] font-normal leading-none">{signed.by.replace(/\s*\(demo signature\)$/, "")}</span>)}
              {signed.sample && fact("Note", <span className="font-normal text-slate-600">A sample approval that came with the demo</span>)}
            </dl>
            {buttons}
          </section>}

          {notAgreed.length > 0 && <section className={`${card} p-5`} aria-labelledby="not-agreed-title">
            <h2 id="not-agreed-title" className="text-[15px] font-bold">Not agreed · {notAgreed.length} {notAgreed.length === 1 ? "line" : "lines"}</h2>
            <p className="mt-1 text-[12px] text-slate-600">Revise a declined line in the next version, or drop it. Undecided lines carry into the next version; withdraw one to leave it out.</p>
            <ul className="mt-3 border-t border-[var(--line)]">{notAgreed.map((line) => {
              const state = lineOf(line.itemId);
              const declined = state.state === "declined";
              return <li key={line.itemId} className="grid gap-1.5 border-b border-[var(--line)] py-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <b className="font-semibold">{line.name}</b>
                  <span className={`text-[11.5px] ${declined ? "text-red-700" : "text-[var(--muted)]"}`}>{declined ? "Declined" : "Undecided"}</span>
                  {state.questions > 0 && <button type="button" onClick={onOpenChat} className="inline-flex items-center gap-1 text-[11.5px] text-[var(--primary)] hover:underline"><MessageCircleQuestion className="h-3.5 w-3.5" />{state.questions} in chat</button>}
                  <span className="ml-auto flex gap-2">
                    {busy === line.itemId ? <LoaderCircle className="h-4 w-4 animate-spin text-[var(--muted)]" /> : dropping === line.itemId ? <>
                      <button type="button" onClick={() => void run(line.itemId, actions.drop)} className="rounded-lg bg-[var(--ink)] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-[#1f241d]">{declined ? "Drop line" : "Withdraw line"}</button>
                      <button type="button" onClick={() => setDropping(null)} className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[11.5px] font-medium hover:bg-[var(--canvas)]">Keep</button>
                    </> : <>
                      {declined && <button type="button" onClick={() => void run(line.itemId, actions.revise)} className="rounded-lg bg-[var(--ink)] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-[#1f241d]">Revise</button>}
                      <button type="button" onClick={() => setDropping(line.itemId)} className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[11.5px] font-medium hover:bg-[var(--canvas)]">{declined ? "Drop…" : "Withdraw…"}</button>
                    </>}
                  </span>
                </div>
                {state.note && <p className="text-[12px] text-slate-600">&ldquo;{state.note}&rdquo;</p>}
              </li>;
            })}</ul>
            {error && <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p>}
          </section>}

          {opening.closed && <p className="rounded-lg bg-[var(--canvas)] p-3 text-[12px] text-slate-600">A newer version replaced V1. Its approved lines carried over as that version&apos;s starting point.</p>}
        </div>
        <div className="min-w-0 rounded-xl bg-[#8e8c85] p-3 sm:p-[18px] lg:col-start-1 lg:row-start-1">
          {!formal && <p role="status" className="flex items-center gap-2 rounded-lg bg-white/90 p-6 text-[13px] text-slate-600"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the formal quote…</p>}
          {formal && "error" in formal && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{formal.error}</p>}
          {formal && "receipt" in formal && <ReceiptDocument receipt={formal.receipt} studioName={studioName} embedded updating={formal.stale} />}
        </div>
      </div>
      {open && opening.progress.approved > 0 && <ProjectPayments projectKey={projectKey} orderId={null} />}
    </div>
  </section>;
}
