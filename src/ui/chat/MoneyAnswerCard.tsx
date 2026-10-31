import { Link2, ReceiptText } from "lucide-react";
import type { MoneyAnswer } from "@/ai/money-types";

function evidenceHref(value: string): string | null {
  return /^\/quotes\/(?:maple|willow)(?:#[\w.%:~-]+)?$/.test(value)
    || /^\/change-orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:#[\w.%:~-]+)?$/i.test(value)
    ? value : null;
}

function recordedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time"
    : `${date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} PT`;
}

export function MoneyAnswerCard({ answer }: { answer: MoneyAnswer }) {
  const sources = new Map(answer.sources.map((source) => [source.id, source]));
  return <section aria-label="Money answer evidence" className="mt-3 rounded-lg border border-amber-200/70 bg-white/80 p-3">
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-amber-950"><ReceiptText className="h-3.5 w-3.5 shrink-0" /><span>Recorded funds · V{answer.version}</span><span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-[9px] font-medium text-amber-800">PayPal Sandbox</span></div>
    <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">Based on the saved records at the time of this answer, not a live PayPal check.</p>
    <dl className="mt-2 space-y-1 text-[10px] leading-relaxed text-slate-500">
      <div><dt className="inline">Records read: </dt><dd className="inline"><time dateTime={answer.checkedAt}>{recordedTime(answer.checkedAt)}</time></dd></div>
      <div><dt className="inline">Latest PayPal record: </dt><dd className="inline">{answer.providerRecordedAt ? <time dateTime={answer.providerRecordedAt}>{recordedTime(answer.providerRecordedAt)}</time> : "No recorded PayPal receipt; the quote does not establish that a payment was made."}</dd></div>
    </dl>
    {answer.facts.length ? <ul className="mt-3 space-y-3 border-t border-amber-100 pt-3">
      {answer.facts.map((fact) => <li key={fact.id}>
        <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-800">{fact.text.en}</p>
        <ul aria-label="Sources for this statement" className="mt-1 space-y-1">
          {[...new Set(fact.sourceIds)].map((id) => {
            const source = sources.get(id);
            if (!source) return null;
            const href = evidenceHref(source.href);
            const label = <><Link2 className="mt-0.5 h-3 w-3 shrink-0" /><span className="min-w-0 break-all">{source.label}</span></>;
            return <li key={id} className="text-[10px] leading-relaxed">{href ? <a href={href} target="_blank" rel="noreferrer" title={source.recordedAt ? recordedTime(source.recordedAt) : undefined} className="inline-flex max-w-full items-start gap-1 text-[var(--primary)] underline decoration-brand-200 underline-offset-2 hover:decoration-brand-500">{label}</a> : <span className="inline-flex max-w-full items-start gap-1 text-slate-500">{label}</span>}</li>;
          })}
        </ul>
      </li>)}
    </ul> : <p className="mt-3 text-[12px] leading-relaxed text-slate-600">The available records do not establish an answer to this money question. Check the project records first.</p>}
  </section>;
}
