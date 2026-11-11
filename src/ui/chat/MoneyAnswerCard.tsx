"use client";

import { Link2, ReceiptText } from "lucide-react";
import { MONEY_STATUS_LABEL, type MoneyAnswer, type MoneyFact, type MoneyTableRow } from "@/ai/money-types";
import { notRefundedText } from "@/pricing/fees";

function evidenceHref(value: string): string | null {
  return /^\/quotes\/[a-z0-9]+(?:-[a-z0-9]+)*(?:#[\w.%:~-]+)?$/.test(value)
    || /^\/change-orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#[\w.%:~-]+)?$/i.test(value)
    ? value : null;
}

function recordedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time"
    : `${date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} PT`;
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

type Money = Pick<MoneyTableRow, "status" | "heldCents" | "chargedCents" | "refundedCents" | "releasedCents" | "nonRefundableCents" | "nonRefundableFees" | "netCents">;

/** States the amounts already say; their word is left out when an amount follows. */
const SHOWN_BY_AMOUNTS = new Set<MoneyTableRow["status"]>(["charged", "on_hold", "refunded", "released"]);

/** The line under an item's name: its status in fixed words, then the money besides what it paid in the end. */
function detail(row: Money): string[] {
  const parts = [
    row.heldCents > 0 && `On hold ${usd(row.heldCents)}`,
    row.chargedCents > 0 && (row.chargedCents !== row.netCents || row.releasedCents > 0 || row.nonRefundableCents > 0) && `Charged ${usd(row.chargedCents)}`,
    row.refundedCents > 0 && `Refunded ${usd(row.refundedCents)}`,
    row.releasedCents > 0 && `Released ${usd(row.releasedCents)}`,
    row.nonRefundableCents > 0 && (row.nonRefundableFees?.length
      ? notRefundedText({ oldItemCostCents: row.nonRefundableCents, oldItemFees: row.nonRefundableFees })
      : `Non-refundable ${usd(row.nonRefundableCents)}`),
  ].filter((part): part is string => !!part);
  const status = SHOWN_BY_AMOUNTS.has(row.status) && parts.length ? null : MONEY_STATUS_LABEL[row.status];
  return [status, ...parts].filter((part): part is string => !!part);
}

/** Each part stays on one line; the line wraps only between parts. */
function Detail({ row }: { row: Money }) {
  return <span className="block text-[11px] text-slate-500">{detail(row).map((part, index) => <span key={part}>{index > 0 && " · "}<span className="whitespace-nowrap">{part}</span></span>)}</span>;
}

/** The item table: statuses and amounts as the records stood when the answer was saved, never the model's words. */
function RecordTable({ rows }: { rows: readonly MoneyTableRow[] }) {
  const sum = (field: keyof Omit<Money, "status" | "nonRefundableFees">) => rows.reduce((total, row) => total + row[field], 0);
  const total: Money = { status: "charged", heldCents: sum("heldCents"), chargedCents: sum("chargedCents"), refundedCents: sum("refundedCents"), releasedCents: sum("releasedCents"), nonRefundableCents: sum("nonRefundableCents"), netCents: sum("netCents") };
  return <figure className="mt-2">
    <table className="w-full rounded-lg bg-white/70 text-[12px]">
      <thead><tr className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
        <th scope="col" className="py-1.5 pl-3 pr-2 text-left font-medium">Item</th>
        <th scope="col" className="py-1.5 pl-2 pr-3 text-right font-medium">Net paid</th>
      </tr></thead>
      <tbody>
        {rows.map((row) => <tr key={row.key} className="border-t border-slate-100">
          <th scope="row" className="py-1.5 pl-3 pr-2 text-left align-baseline font-normal">
            <span className="block font-medium">{row.label}</span>
            <Detail row={row} />
          </th>
          <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right align-baseline font-semibold tabular-nums">{usd(row.netCents)}</td>
        </tr>)}
      </tbody>
      {rows.length > 1 && <tfoot><tr className="border-t border-slate-200">
        <th scope="row" className="py-1.5 pl-3 pr-2 text-left align-baseline font-normal">
          <span className="block font-semibold">Total</span>
          <Detail row={total} />
        </th>
        <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right align-baseline font-semibold tabular-nums">{usd(total.netCents)}</td>
      </tr></tfoot>}
    </table>
    <figcaption className="mt-1 text-[10px] text-slate-500">From the PayPal Sandbox records</figcaption>
  </figure>;
}

/**
 * A money reply. Setti's verified answer reads like a chat message: its
 * conclusion, the item table built from the records, then short notes; every
 * sentence was checked against the records of what it is about, but the
 * citations stay out of the chat. The records themselves appear only when Setti
 * shows them because the person asked for the evidence. Without a written
 * answer, the table and the records are the reply.
 */
export function MoneyAnswerCard({ answer, messageId }: { answer: MoneyAnswer; messageId: string }) {
  const body = answer.answer;
  const sources = new Map(answer.sources.map((source) => [source.id, source]));
  const facts: MoneyFact[] = answer.facts;

  const records = <section aria-label="Money answer evidence" className="mt-3 rounded-lg border border-slate-200 bg-white/80 p-3">
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-800"><ReceiptText className="h-3.5 w-3.5 shrink-0" /><span>Recorded funds · V{answer.version}</span></div>
    <p className="text-[10px] leading-relaxed text-slate-500">Saved PayPal Sandbox records read <time dateTime={answer.checkedAt}>{recordedTime(answer.checkedAt)}</time>{answer.providerRecordedAt ? <>; latest PayPal record <time dateTime={answer.providerRecordedAt}>{recordedTime(answer.providerRecordedAt)}</time></> : "; no recorded PayPal receipt"}. Not a live PayPal check.</p>
    {facts.length ? <ol className="mt-3 space-y-3 border-t border-slate-100 pt-3">
      {facts.map((fact, index) => <li key={fact.id} id={`money-${messageId}-fact-${index + 1}`} className="flex gap-2">
        <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-slate-100 px-1 text-[9px] font-semibold text-slate-700">{index + 1}</span>
        <div className="min-w-0">
          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-700">{fact.text.en}</p>
          <ul aria-label="Sources for this statement" className="mt-1 space-y-0.5">
            {[...new Set(fact.sourceIds)].map((id) => {
              const source = sources.get(id);
              if (!source) return null;
              const href = evidenceHref(source.href);
              const label = <><Link2 className="mt-0.5 h-3 w-3 shrink-0" /><span className="min-w-0 break-all">{source.label}</span></>;
              return <li key={id} className="text-[10px] leading-relaxed">{href ? <a href={href} target="_blank" rel="noreferrer" title={source.recordedAt ? recordedTime(source.recordedAt) : undefined} className="inline-flex max-w-full items-start gap-1 text-[var(--primary)] underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">{label}</a> : <span className="inline-flex max-w-full items-start gap-1 text-slate-500">{label}</span>}</li>;
            })}
          </ul>
        </div>
      </li>)}
    </ol> : <p className="mt-3 text-[12px] leading-relaxed text-slate-600">The available records do not establish an answer to this money question. Check the project records first.</p>}
  </section>;

  const table = answer.table?.length ? <RecordTable rows={answer.table} /> : null;
  if (!body) return table ? <>{table}<details className="mt-2 text-[11px] text-slate-600"><summary className="cursor-pointer">Show the records</summary>{records}</details></> : records;

  return <>
    <p className="break-words text-[13px] font-medium leading-relaxed">{body.summary.text}</p>
    {table}
    {!table && body.rows.length > 0 && <table className="mt-2 w-full overflow-hidden rounded-lg bg-white/70 text-[12px]">
      <thead><tr className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]"><th scope="col" className="py-1.5 pl-3 pr-2 text-left font-medium">Item</th><th scope="col" className="px-2 py-1.5 text-left font-medium">What happened</th><th scope="col" className="py-1.5 pl-2 pr-3 text-right font-medium">Charged now</th></tr></thead>
      <tbody>
        {body.rows.map((row, index) => <tr key={index} className="border-t border-slate-100">
          <td className="py-1.5 pl-3 pr-2 align-baseline font-medium">{row.label}</td>
          <td className="px-2 py-1.5 align-baseline text-slate-600">{row.status}</td>
          <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right align-baseline font-semibold tabular-nums">{row.amount ?? ""}</td>
        </tr>)}
      </tbody>
    </table>}
    {body.notes.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-slate-700">
      {body.notes.map((note, index) => <li key={index}>{note.text}</li>)}
    </ul>}
    {answer.showEvidence && records}
  </>;
}
