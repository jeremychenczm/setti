"use client";

import { GitMerge } from "lucide-react";
import type { CarryOverConflict } from "@/pricing/carry-over";

/**
 * Lines where the designer and the newer draft changed the same fields. Each
 * line keeps either the designer's values or the draft's for those fields; every
 * other field was already merged. Editing waits until every line has a choice.
 */
export function CarryOverChoices({ conflicts, choices, onChoose, disabled }: { conflicts: CarryOverConflict[]; choices: Record<string, "mine" | "latest">; onChoose: (key: string, choice: "mine" | "latest") => void; disabled: boolean }) {
  const open = conflicts.filter((conflict) => !choices[conflict.key]).length;
  const option = (active: boolean) => `rounded-lg border px-3 py-1.5 text-[12px] font-medium disabled:opacity-50 ${active ? "border-amber-900 bg-amber-900 text-white" : "border-amber-300 bg-white text-amber-950 hover:bg-amber-100"}`;
  return (
    <section aria-label="Choose between your edits and the updated draft" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-950 sm:p-5">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold"><GitMerge className="h-4 w-4" />The updated draft changed values you had edited</h2>
      <p className="mt-1 text-amber-900">{open ? `Choose which values to keep on ${open === 1 ? "this line" : `these ${open} lines`}. Your other edits are already kept, and editing resumes once every line has a choice.` : "Every line has a choice. Check the review below and save it."}</p>
      <ul className="mt-3 space-y-3">
        {conflicts.map((conflict) => {
          const choice = choices[conflict.key];
          return (
            <li key={conflict.key} className="rounded-lg bg-white p-3 shadow-sm">
              <div className="mb-2 font-semibold">{conflict.name}</div>
              <dl className="max-w-2xl space-y-1">
                <div className="grid grid-cols-[110px_1fr_1fr] gap-2 text-[11px] text-slate-500"><dt /><dd>Your edit</dd><dd>Updated draft</dd></div>
                {conflict.changes.map((field) => (
                  <div key={field.label} className="grid grid-cols-[110px_1fr_1fr] gap-2 text-[12px]">
                    <dt className="text-slate-500">{field.label}</dt>
                    <dd className={`min-w-0 break-words ${choice === "latest" ? "text-slate-400 line-through" : "font-medium"}`}>{field.before}</dd>
                    <dd className={`min-w-0 break-words ${choice === "mine" ? "text-slate-400 line-through" : "font-medium"}`}>{field.after}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" aria-pressed={choice === "mine"} disabled={disabled} onClick={() => onChoose(conflict.key, "mine")} className={option(choice === "mine")}>Keep my edit</button>
                <button type="button" aria-pressed={choice === "latest"} disabled={disabled} onClick={() => onChoose(conflict.key, "latest")} className={option(choice === "latest")}>Use the updated draft</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
