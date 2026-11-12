"use client";

import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey, CaseMessage, ChangeDraft } from "@/chat/types";
import { reviewSummary, type CarriedSummary, type FieldChange, type ReviewLine, type ReviewSummary } from "@/pricing/review-diff";
import type { PricingWorkspace } from "@/pricing/types";
import { FromV1Note } from "../pricing/common";
import { Act, Amount, ChangeRow, DraftCard, Fold, RowsHeading, TotalsLine, Was } from "./DraftCard";
import { draftEstimate, type DraftEstimate } from "./draft-pricing";

const ACT: Record<ReviewLine["kind"], string> = { revised: "Revised from V1", carried: "From V1", changed: "Changed", added: "Added", removed: "Removed" };
/** Short fields read well in one line; long ones (specification, terms) wait in the details. */
const SHORT = ["Quantity", "Unit price", "Name", "Supplier", "SKU", "Tax", "Delivery", "Room", "Returns"];

function sentLabel(sent: NonNullable<ReviewSummary["sent"]>): string {
  const state = sent.status === "approved" ? "confirmed by the client" : sent.status === "declined" ? "the client asked for changes" : sent.status === "superseded" ? "replaced by a later version" : "awaiting the client";
  return `Sent as V${sent.version} · ${state}`;
}

/** The line's change in a few words; the full field list is in its details. */
function lineText(line: ReviewLine) {
  const after = (label: string) => line.changes.find((change) => change.label === label)?.after;
  if (line.kind === "added") return <><Act>Added</Act>{[after("Quantity"), after("Unit price")].filter(Boolean).join(" × ")}</>;
  if (line.kind === "removed") return <><Act>Removed</Act>{line.changes[0]?.before}</>;
  if (!line.changes.length) return <><Act>{ACT[line.kind]}</Act>no values changed</>;
  const short = line.changes.filter((change) => SHORT.includes(change.label)).sort((a, b) => SHORT.indexOf(a.label) - SHORT.indexOf(b.label)).slice(0, 2);
  const more = line.changes.length - short.length;
  return <><Act>{ACT[line.kind]}</Act>{short.map((change, index) => <span key={change.label}>{index > 0 && " · "}{change.label} <Was>{change.before}</Was> → {change.after}</span>)}{more > 0 && <span className="text-[var(--muted)]">{short.length ? " · " : ""}{more} more {more === 1 ? "field" : "fields"}</span>}</>;
}

function Fields({ line }: { line: ReviewLine }) {
  if (line.kind === "added") return <p>{line.changes.map((change: FieldChange) => `${change.label}: ${change.after}`).join(" · ")}</p>;
  return <dl className="space-y-1">{line.changes.map((change) => <div key={change.label} className="grid grid-cols-[90px_1fr] gap-2"><dt className="text-[var(--muted)]">{change.label}</dt><dd className="min-w-0 break-words"><Was>{change.before}</Was> <span className="text-slate-400">→</span> <span className="font-medium text-[var(--ink)]">{change.after}</span></dd></div>)}</dl>;
}

function CheckState({ line }: { line: ReviewLine }) {
  if (line.needsChoice) return <span className="rounded-full bg-amber-100 px-2 py-px text-[11px] font-medium text-amber-800">Needs your choice</span>;
  return line.confirmed ? <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700"><Check className="h-3 w-3" />Checked</span> : <span className="text-[11px] text-amber-700">Not checked</span>;
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

/**
 * The designer's view of the current draft: once a pricing review is saved, what
 * it changes line by line against the quote; before that, the draft as proposed.
 * Review pricing sits in the dialog's header, so it is in view without scrolling.
 */
export function ReviewPanel({ projectKey, draft, messages, onSourceMessage }: { projectKey: CaseKey; draft: ChangeDraft; messages: CaseMessage[]; onSourceMessage: (id: string) => void }) {
  const [summary, setSummary] = useState<ReviewSummary | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<DraftEstimate | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
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
      setClientName(workspace.quote.clientName || null);
      setEstimate(draftEstimate(workspace, { id: draft.id, revision: draft.revision }));
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setSummary(null);
      setEstimate(null);
      setError(cause instanceof Error ? cause.message : "The pricing review could not be loaded.");
    }
  }, [projectKey, draft.id, draft.revision]);

  useEffect(() => { const sequence = requestSequence; void load(); return () => { sequence.current++; }; }, [load]);

  if (summary === undefined) return <div role="status" className="flex items-center gap-2 p-5 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the pricing review…</div>;
  if (!summary || summary.stale) {
    const notice = <>
      {summary?.stale && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">The draft changed after your last saved pricing review. Re-price it from the latest draft on the pricing page.</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-800">{error}</p>}
    </>;
    return <DraftCard draft={draft} messages={messages} onSourceMessage={onSourceMessage} estimate={estimate} clientName={clientName} notice={notice} />;
  }

  const ready = summary.sent || summary.ready;
  return (
    <article className="space-y-5 p-5 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <span className={`rounded-full px-2.5 py-1 font-semibold ${ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{summary.carried ? "Not saved on the updated draft" : summary.sent ? sentLabel(summary.sent) : summary.ready ? "Ready to send to the client" : "Checks still open"}</span>
        <span className="text-[var(--muted)]">{summary.confirmed} of {summary.lines.length} lines checked · saved review {summary.version}{summary.carried && ", carried onto the updated draft"}</span>
        <button onClick={() => void load()} aria-label="Reload the saved pricing review" className="ml-auto rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)]"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <TotalsLine from={summary.baselineTotalCents} to={summary.proposedTotalCents} delta={summary.deltaCents} />

      {summary.carried && <CarriedNote carried={summary.carried} />}

      <section>
        <RowsHeading side="Difference">{summary.lines.length} {summary.lines.length === 1 ? "change" : "changes"}</RowsHeading>
        <ul className="border-t border-[var(--line)]">{summary.lines.map((line) => (
          <ChangeRow key={line.key} name={line.name} what={lineText(line)} side={<><Amount cents={line.deltaCents} /><CheckState line={line} /></>}>
            <FromV1Note fromV1={line.fromV1} changes={line.changes} />
            {line.changes.length ? <Fields line={line} /> : <p>No values changed from V1.</p>}
          </ChangeRow>
        ))}</ul>
      </section>

      <p className="text-[11px] text-[var(--muted)]">{summary.carried ? "Nothing here is saved on the updated draft yet. Open Review pricing to check it and save." : "Only saved changes appear here. Reload after saving on the pricing page."}</p>
      <div className="border-t border-[var(--line)]"><Fold title="The draft as first proposed" count={`${draft.changes.length} ${draft.changes.length === 1 ? "change" : "changes"}`}><DraftCard draft={draft} messages={messages} onSourceMessage={onSourceMessage} clientName={clientName} /></Fold></div>
    </article>
  );
}
