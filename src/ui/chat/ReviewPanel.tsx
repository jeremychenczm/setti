"use client";

import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey, CaseMessage, ChangeDraft } from "@/chat/types";
import { reviewSummary, type CarriedSummary, type ReviewLine, type ReviewSummary } from "@/pricing/review-diff";
import type { PricingWorkspace } from "@/pricing/types";
import { createPricingInput, previewPricing } from "@/pricing/calculation";
import { isHomeQuote } from "@/demo/home-evidence";
import { FromV1Note } from "../pricing/common";
import { DraftCard } from "./DraftCard";

const KIND_LABELS: Record<ReviewLine["kind"], string> = { revised: "Revised from V1", carried: "Carried over from V1", changed: "Changed", added: "New line", removed: "Removed" };

function signed(cents: number): string {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(cents) / 100);
  return cents < 0 ? `−${amount}` : `+${amount}`;
}

function sentLabel(sent: NonNullable<ReviewSummary["sent"]>): string {
  const state = sent.status === "approved" ? "confirmed by the client" : sent.status === "declined" ? "the client asked for changes" : sent.status === "superseded" ? "replaced by a later version" : "awaiting the client";
  return `Sent as V${sent.version} · ${state}`;
}

/** What happened to the saved review when the draft changed under it. */
function CarriedNote({ carried }: { carried: CarriedSummary }) {
  const rows: [string, string[]][] = [["Needs your choice", carried.conflicts], ["Updated from the draft", carried.updated], ["Your edits kept", carried.kept], ["New in the draft", carried.added], ["No longer in the draft", carried.removed]];
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-950">
      <p className="font-semibold">The draft changed after your saved review</p>
      <p className="mt-0.5 text-amber-900">Your review was carried onto it. Fields only the draft changed take its values; fields you edited keep yours.</p>
      <dl className="mt-2 space-y-1">{rows.filter(([, names]) => names.length).map(([label, names]) => (
        <div key={label} className="grid grid-cols-[120px_1fr] gap-2"><dt className="text-amber-800">{label}</dt><dd className="min-w-0 break-words font-medium">{names.join(", ")}</dd></div>
      ))}</dl>
    </div>
  );
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * The designer's view of the current draft: once a pricing review is saved, what
 * it changes line by line against the quote; before that, the draft as proposed.
 */
/** Review pricing sits in the dialog's header, so it is in view without scrolling. */
export function ReviewPanel({ projectKey, draft, messages, onSourceMessage }: { projectKey: CaseKey; draft: ChangeDraft; messages: CaseMessage[]; onSourceMessage: (id: string) => void }) {
  const [summary, setSummary] = useState<ReviewSummary | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ baseline: number; total: number; difference: number; retained: number } | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const response = await fetch(`/api/pricing/${projectKey}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (requestId !== requestSequence.current) return;
      if (!response.ok) throw new Error(body?.error ?? "The pricing review could not be loaded.");
      setError(null);
      const workspace = body as PricingWorkspace;
      setSummary(reviewSummary(workspace));
      setEstimate(null);
      if (isHomeQuote(workspace.quote) && workspace.sourceDraft?.id === draft.id && workspace.sourceDraft.revision === draft.revision) {
        const proposed = createPricingInput(workspace.quote, workspace.sourceDraft);
        const preview = previewPricing(workspace.quote, workspace.sourceDraft, proposed);
        if (preview.proposedTotals && preview.deltaTotalCents !== null) setEstimate({ baseline: preview.baselineTotals.totalCents, total: preview.proposedTotals.totalCents, difference: preview.deltaTotalCents, retained: proposed.changes.reduce((sum, change) => sum + (change.oldItemCostCents ?? 0), 0) });
      }
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setSummary(null);
      setEstimate(null);
      setError(cause instanceof Error ? cause.message : "The pricing review could not be loaded.");
    }
  }, [projectKey, draft.id, draft.revision]);

  useEffect(() => { const sequence = requestSequence; void load(); return () => { sequence.current++; }; }, [load]);

  if (summary === undefined) return <div role="status" className="flex items-center gap-2 p-4 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the pricing review…</div>;
  const draftCard = <DraftCard draft={draft} messages={messages} onSourceMessage={onSourceMessage} />;
  if (!summary || summary.stale) {
    return <>
      {estimate ? <div className="mx-4 mt-4 rounded-xl border border-stone-200 bg-stone-50 p-3.5"><p className="text-[11px] font-semibold text-stone-700">Proposed estimate · needs your review</p><p className="mt-1.5 text-[15px] font-semibold text-stone-900">{usd(estimate.baseline)} → {usd(estimate.total)} <span className="text-[12px] font-medium text-stone-600">({signed(estimate.difference)})</span></p><p className="mt-2 text-[11px] leading-relaxed text-stone-600">Calculated from the AI-selected source products and sample terms, including {usd(estimate.retained)} in non-refundable fees. This is the proposed agreement total; payment actions are planned separately.</p><p className="mt-2 text-[11px] text-stone-600">Open Review pricing, adopt this draft if prompted, and review the preselected demo checks before sending it to Emma.</p></div> : <p className="mx-4 mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">{summary?.stale ? "The draft changed after your last saved pricing review. Re-price it from the latest draft on the pricing page." : "Not priced yet. Once you save a pricing review, this panel shows what you changed, line by line."}</p>}
      {error && <p role="alert" className="mx-4 mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-800">{error}</p>}
      {draftCard}
    </>;
  }

  return (
    <article className="space-y-4 p-4 text-[12px]">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`rounded-full px-2.5 py-1 font-medium ${summary.sent || summary.ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{summary.carried ? "Not saved on the updated draft" : summary.sent ? sentLabel(summary.sent) : summary.ready ? "Ready to send to the client" : "Checks still open"}</span>
          <span className="text-[var(--muted)]">Saved review {summary.version}{summary.carried && ", carried onto the updated draft"} · {summary.confirmed} of {summary.lines.length} lines checked</span>
          <button onClick={() => void load()} aria-label="Reload the saved pricing review" className="ml-auto rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)]"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        <h2 className="text-[15px] font-semibold leading-snug">{draft.title}</h2>
        <p className="mt-1.5 text-[12px] text-slate-600">Approved V{draft.basedOnVersion} {usd(summary.baselineTotalCents)} → proposed {summary.proposedTotalCents === null ? "not priced" : usd(summary.proposedTotalCents)}{summary.deltaCents !== null && ` (${signed(summary.deltaCents)})`}</p>
      </div>

      {summary.carried && <CarriedNote carried={summary.carried} />}

      <ol className="space-y-3">
        {summary.lines.map((line, index) => (
          <li key={line.key} className="rounded-xl border border-[var(--line)] p-3">
            <div className="mb-1.5 flex items-start gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-[var(--primary)]">{index + 1}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold">{line.name}</span><span className="text-[11px] text-[var(--muted)]">{line.kind === "carried" ? line.changes.length ? "Carried over from V1, with changes" : "Carried over from V1, unchanged" : KIND_LABELS[line.kind]}</span></span>
              {line.needsChoice ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">Needs your choice</span> : line.confirmed ? <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />Checked</span> : <span className="text-[11px] text-amber-700">Not checked</span>}
            </div>
            <FromV1Note fromV1={line.fromV1} changes={line.changes} className="mb-2" />
            {line.changes.length ? <dl className="space-y-1">{line.changes.map((change) => (
              <div key={change.label} className="grid grid-cols-[84px_1fr] gap-2 text-[11px] leading-relaxed">
                <dt className="text-[var(--muted)]">{change.label}</dt>
                <dd className="min-w-0 break-words"><span className="text-slate-500 line-through decoration-slate-300">{change.before}</span> <span className="text-slate-400">→</span> <span className="font-medium">{change.after}</span></dd>
              </div>
            ))}</dl> : <p className="text-[11px] text-[var(--muted)]">No values changed from V1.</p>}
          </li>
        ))}
      </ol>

      <p className="text-[10px] leading-relaxed text-[var(--muted)]">{summary.carried ? "Nothing here is saved on the updated draft yet. Open Review pricing to check it and save." : "Only saved changes appear here. Reload after saving on the pricing page."}</p>
      <details className="rounded-xl border border-dashed border-[var(--line)]"><summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-slate-600">The draft as first proposed</summary>{draftCard}</details>
    </article>
  );
}
