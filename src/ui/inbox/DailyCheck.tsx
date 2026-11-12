"use client";

import { when } from "./inbox-rows";
import { CARD } from "./parts";

/** A daily check older than this has missed its run. */
const OVERDUE_MS = 36 * 60 * 60 * 1000;

function Line({ label, value, warn = false, title }: { label: string; value: string; warn?: boolean; title?: string }) {
  return <p className="flex justify-between gap-2.5 text-[12px] text-slate-600"><span>{label}</span><b title={title} className={`text-right font-semibold ${warn ? "text-amber-700" : "text-[var(--ink)]"}`}>{value}</b></p>;
}

/** When the daily check last ran, said plainly when it is missing, late or could not check something. */
/** `live`: the projects whose holds the check reads back from PayPal; example projects are fixed records. */
export function DailyCheck({ check, live }: { check: { at: string; problems: string[] } | null; live: number }) {
  const late = !check || Date.now() - new Date(check.at).getTime() > OVERDUE_MS;
  const problems = check?.problems ?? [];
  return <section aria-labelledby="daily-check" className={`${CARD} grid gap-2`}>
    <h2 id="daily-check" className="text-[12px] font-semibold text-slate-600">Daily check</h2>
    <Line label="Last checked" value={check ? `${when(check.at)}${late ? " · overdue" : ""}` : "Not run yet"} warn={late} />
    <Line label="Read back from PayPal" value={`${live} live ${live === 1 ? "project" : "projects"}`} />
    <Line label="Problems" value={!check ? "—" : problems.length ? `${problems.length} could not be checked` : "None"} warn={problems.length > 0} title={problems.join(" · ") || undefined} />
    {problems.length > 0 && <ul className="space-y-0.5 text-[11px] leading-relaxed text-amber-800">{problems.slice(0, 3).map((problem) => <li key={problem}>{problem}</li>)}{problems.length > 3 && <li>and {problems.length - 3} more</li>}</ul>}
  </section>;
}
