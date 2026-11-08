"use client";

import { Search } from "lucide-react";
import { describeQuoteQuery, type QuoteAnswer } from "@/ai/quote-query";
import { usd } from "../demo-data";

/**
 * A quote lookup's result. The sentence above it is Coordinator's; everything
 * in this card was computed by the server from the approved quote, including
 * the plain-words description of what was looked up.
 */
export function QuoteAnswerCard({ answer }: { answer: QuoteAnswer }) {
  const limited = answer.rows.length < answer.matchedCount;
  return <section aria-label="Quote lookup" className="mt-2 rounded-lg border border-slate-200 bg-white/80 p-3">
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-800">
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span>Quote V{answer.version} · {answer.matchedCount} matching line{answer.matchedCount === 1 ? "" : "s"}</span>
    </div>
    <ul aria-label="What was looked up" className="mt-1.5 flex flex-wrap gap-1">
      {describeQuoteQuery(answer.query).map((part) => <li key={part} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{part}</li>)}
    </ul>
    {answer.rows.length ? <table className="mt-2 w-full text-[12px]">
      <thead><tr className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
        <th scope="col" className="py-1.5 pr-2 text-left font-medium">Item</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">Qty</th>
        <th scope="col" className="px-2 py-1.5 text-right font-medium">Unit price</th>
        <th scope="col" className="py-1.5 pl-2 text-right font-medium">Line total</th>
      </tr></thead>
      <tbody>
        {answer.rows.map((row) => <tr key={row.itemId} className="border-t border-slate-100">
          <td className="py-1.5 pr-2 align-baseline"><div className="font-medium">{row.name}</div><div className="text-[10px] text-[var(--muted)]">{row.room} · {row.supplier}</div></td>
          <td className="px-2 py-1.5 text-right align-baseline tabular-nums">{row.quantity}</td>
          <td className="whitespace-nowrap px-2 py-1.5 text-right align-baseline tabular-nums">{usd(row.unitPriceCents)}<span className="text-[10px] text-[var(--muted)]"> / {row.unitLabel}</span></td>
          <td className="whitespace-nowrap py-1.5 pl-2 text-right align-baseline font-semibold tabular-nums">{usd(row.lineTotalCents)}</td>
        </tr>)}
      </tbody>
      <tfoot><tr className="border-t border-slate-200 text-[11px]">
        <td colSpan={3} className="py-1.5 pr-2 text-slate-600">{limited ? `Showing ${answer.rows.length} of ${answer.matchedCount} · ` : ""}Total of these lines</td>
        <td className="whitespace-nowrap py-1.5 pl-2 text-right font-semibold tabular-nums">{usd(answer.totalCents)}</td>
      </tr></tfoot>
    </table> : <p className="mt-2 text-[12px] leading-relaxed text-slate-600">No line in quote V{answer.version} matches.</p>}
    <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Calculated by Setti from the approved quote, not by the AI. Line totals include each line&apos;s tax and delivery.</p>
  </section>;
}
