"use client";

import { Archive } from "lucide-react";
import { useEffect, useState } from "react";

interface DemoEnd { at: string; reason: "idle" | "visitor" }

/** Tells whoever opens an ended demo that its project is now a read-only record. */
export function DemoEndedNotice() {
  const [end, setEnd] = useState<DemoEnd | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/try", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ demoEnded?: DemoEnd | null }> : null)
      .then((body) => { if (body?.demoEnded && typeof body.demoEnded.at === "string") setEnd(body.demoEnded); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!end) return null;
  const day = new Date(end.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] leading-relaxed text-slate-700">
    <Archive className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
    <span className="min-w-0 flex-1">
      {end.reason === "idle" ? `This demo ended on ${day} after a week without activity.` : `This demo was ended on ${day}.`}
      {" "}Its holds were released on PayPal, and this project is now a read-only record.
    </span>
    <a href="/try" className="font-medium text-slate-900 underline underline-offset-2">Start a new demo</a>
  </div>;
}
