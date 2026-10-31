"use client";

import type { ChangeSource } from "@/pricing/types";
import { Field, inputClass } from "./common";

const options: { kind: ChangeSource["kind"]; label: string; hint: string }[] = [
  { kind: "client", label: "Client request", hint: "The client asked for it in the chat." },
  { kind: "designer", label: "Studio proposal", hint: "You propose it to the client." },
  { kind: "vendor", label: "Supplier notice", hint: "A supplier changed a price or term." },
];

/** Why this version changes the agreement. The client sees it on the version before confirming. */
export function ChangeSourceFields({ value, disabled, onChange }: { value: ChangeSource; disabled: boolean; onChange: (source: ChangeSource) => void }) {
  return <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5">
    <h2 className="mb-1 text-[14px] font-semibold">Why this version</h2>
    <p className="mb-3 text-[11px] leading-relaxed text-slate-500">Shown to the client with the version. Whatever the reason, the client confirms the new version before any money moves.</p>
    <fieldset disabled={disabled}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Why this version">{options.map((option) => <label key={option.kind} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[12px] ${value.kind === option.kind ? "border-brand-300 bg-brand-50" : "border-slate-200"}`}>
        <input type="radio" name="change-source" className="mt-0.5" checked={value.kind === option.kind} onChange={() => onChange({ ...value, kind: option.kind })} />
        <span><span className="block font-medium">{option.label}</span><span className="block text-[10px] text-slate-500">{option.hint}</span></span>
      </label>)}</div>
      {value.kind === "vendor" && <div className="mt-3 grid gap-3 lg:grid-cols-[240px_1fr]">
        <Field label="Supplier" hint="Required."><input aria-label="Supplier" className={inputClass} value={value.vendor} onChange={(event) => onChange({ ...value, vendor: event.target.value })} placeholder="e.g. Linden Textiles" /></Field>
        <Field label="What the notice says" hint="Required. Quote or summarize the supplier's notice: what changed, by how much and from when."><textarea aria-label="What the supplier's notice says" rows={3} className={inputClass} value={value.notice} onChange={(event) => onChange({ ...value, notice: event.target.value })} /></Field>
      </div>}
    </fieldset>
  </section>;
}

const labels: Record<ChangeSource["kind"], string> = { client: "Requested by the client", designer: "Proposed by the studio", vendor: "Supplier notice" };

/** Why a version changes the agreement, as the client reads it. */
export function ChangeSourceNote({ source, detailed = false }: { source: ChangeSource; detailed?: boolean }) {
  if (source.kind !== "vendor") return <span className="text-[11px] text-slate-500">{labels[source.kind]}</span>;
  return <span className={detailed ? "block rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900" : "text-[11px] font-medium text-amber-800"}>
    {labels.vendor} · {source.vendor}{detailed && <span className="mt-1 block whitespace-pre-wrap font-normal">{source.notice}</span>}
  </span>;
}
