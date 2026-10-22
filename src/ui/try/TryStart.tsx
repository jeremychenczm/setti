"use client";

import { CircleCheck, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type State =
  | { kind: "checking" }
  | { kind: "returning"; href: string }
  | { kind: "preparing" }
  | { kind: "failed"; error: string };

const seeded = [
  "Emma confirms V2 of the Maple Ave project",
  "$800 held on PayPal for the lounge chair",
  "$300 captured for the wool rug after its supplier confirmed the order",
];

async function errorOf(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `The demo could not start (HTTP ${response.status}).`;
}

export function TryStart() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "checking" });
  const started = useRef(false);

  const start = useCallback(async (restart: boolean) => {
    setState({ kind: "preparing" });
    try {
      const response = await fetch("/api/try", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ restart }) });
      if (!response.ok) return setState({ kind: "failed", error: await errorOf(response) });
      const { href } = await response.json() as { href: string };
      router.replace(href);
    } catch {
      setState({ kind: "failed", error: "The demo could not be reached. Check your connection and try again." });
    }
  }, [router]);

  useEffect(() => {
    // Strict mode runs effects twice in development; seed at most once per page load.
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const response = await fetch("/api/try", { cache: "no-store" });
        if (!response.ok) return setState({ kind: "failed", error: await errorOf(response) });
        const { seed, href } = await response.json() as { seed: { status: string } | null; href: string };
        if (seed?.status === "ready") setState({ kind: "returning", href });
        else await start(false);
      } catch {
        setState({ kind: "failed", error: "The demo could not be reached. Check your connection and try again." });
      }
    })();
  }, [start]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--canvas)] p-4 text-[var(--ink)]">
      <section className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary)] text-sm font-bold text-white">S</span>
          <span className="text-sm font-semibold">Setti</span>
        </div>
        <h1 className="mt-5 text-[19px] font-semibold">Try Setti</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">Setti keeps an interior design project&rsquo;s money in step with every change the client confirms. Your demo project starts with money already on PayPal Sandbox.</p>

        {state.kind === "returning" ? (
          <div className="mt-6">
            <p className="flex items-center gap-2 text-[13px] font-medium"><CircleCheck className="h-4 w-4 text-emerald-600" />Your demo project is ready.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={state.href} className="rounded-full bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-white">Open Maple Ave</Link>
              <button onClick={() => start(true)} className="rounded-full border border-[var(--line)] px-4 py-2 text-[13px] font-medium">Start over with a new project</button>
            </div>
          </div>
        ) : (
          <ul className="mt-6 space-y-2.5" aria-live="polite">
            {seeded.map((line) => (
              <li key={line} className="flex items-start gap-2 text-[13px]">
                {state.kind === "failed" ? <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" /> : <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--primary)]" />}
                {line}
              </li>
            ))}
          </ul>
        )}

        {state.kind === "failed" && (
          <div role="alert" className="mt-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800">
            <p>{state.error}</p>
            <button onClick={() => start(false)} className="mt-2 flex items-center gap-1.5 font-medium hover:underline"><RefreshCw className="h-3 w-3" />Try again</button>
          </div>
        )}

        <p className="mt-6 border-t border-[var(--line)] pt-4 text-[11px] leading-relaxed text-[var(--muted)]">These are real PayPal Sandbox transactions. Setti approves them with a Sandbox test card, so you need no PayPal account, and no real money moves.</p>
      </section>
    </main>
  );
}
