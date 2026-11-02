"use client";

/** A daily check older than this has missed its run. */
const OVERDUE_MS = 36 * 60 * 60 * 1000;

const when = (value: string) => new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** When the daily check last ran, said plainly when it is missing, late or could not check something. */
export function LastCheck({ check }: { check: { at: string; problems: string[] } | null }) {
  const late = !check || Date.now() - new Date(check.at).getTime() > OVERDUE_MS;
  const text = !check ? "The daily check has not run yet."
    : check.problems.length ? `Last checked ${when(check.at)} · ${check.problems.length} could not be checked.`
      : `Last checked ${when(check.at)}${late ? " · overdue" : ""}`;
  return <p title={check?.problems.join(" · ") || undefined} className={`px-2 pt-0.5 text-[10px] ${late || check?.problems.length ? "text-amber-700" : "text-slate-400"}`}>{text}</p>;
}
