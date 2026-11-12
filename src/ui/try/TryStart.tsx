"use client";
/**
 * /try opens the live demo straight away: it starts this browser's Maple run (or reuses it),
 * waits until the project can open and opens it as Jordan, the designer. Payment setup still
 * running continues in the background inside the app. The page does nothing until this script
 * runs, so links, prefetches and crawlers never create a run.
 */
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { switchPersona } from "../account/switchPersona";
import { BUTTON, Shell } from "../account/AuthForm";
import { announceTryProgress, canOpenPreparedWorkspace, type PreparationSeed } from "./TryPreparationProvider";

type Snapshot = { seed: PreparationSeed | null; href: string; demoEnded?: { at: string } | null; signedInAs?: string | null };
type Phase = "starting" | "signed-in" | "preparing" | "opening" | "failed";

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<Snapshot>;
  return "seed" in body && typeof body.href === "string"
    && (body.seed === null || !!body.seed && typeof body.seed.runId === "string" && Array.isArray(body.seed.stages));
}
function errorText(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return `The demo could not be reached (HTTP ${status}).`;
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 1_200);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function TryStart() {
  const [phase, setPhase] = useState<Phase>("starting");
  const [seed, setSeed] = useState<PreparationSeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  const call = useCallback(async (signal: AbortSignal, body?: object): Promise<Snapshot> => {
    const response = await fetch("/api/try", body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }
      : { cache: "no-store", signal });
    const result: unknown = await response.json().catch(() => null);
    if (isSnapshot(result) && !signal.aborted) { setSeed(result.seed); if (body) announceTryProgress(result.seed); }
    if (!response.ok) throw new Error(errorText(result, response.status));
    if (!isSnapshot(result)) throw new Error("The server returned incomplete demo records. Try again.");
    return result;
  }, []);

  /** Starts or reuses the run, prepares it until the project can open, then opens it. */
  const open = useCallback(async (signal: AbortSignal, switchAccount: boolean) => {
    setPhase("starting"); setError(null);
    const first = await call(signal);
    if (first.signedInAs && !switchAccount) { setSignedInAs(first.signedInAs); setPhase("signed-in"); return; }
    const start = (restart: boolean) => call(signal, { action: "start", scenario: HOME_SCENARIO, ...(restart ? { restart: true } : {}) });
    // A demo that has ended stays a read-only record; the visitor gets a fresh one.
    let current = await start(!!first.demoEnded);
    if (current.demoEnded) current = await start(true);
    setPhase("preparing");
    while (!current.seed || !canOpenPreparedWorkspace(current.seed)) {
      const run = current.seed;
      if (!run) throw new Error("The demo project could not be found. Try again.");
      if (run.status === "failed" && !run.canResume && !run.busy) throw new Error(run.error || "The demo could not be prepared. Try again.");
      if (run.busy) {
        // Another tab is preparing this run: read its progress instead of posting more work.
        await pause(signal);
        current = await call(signal);
      } else {
        current = await call(signal, { action: "prepare", runId: run.runId });
        if (current.seed && !canOpenPreparedWorkspace(current.seed)) await pause(signal);
      }
    }
    if (signal.aborted) return;
    setPhase("opening");
    const problem = await switchPersona("jordan", current.href);
    if (problem) throw new Error(problem);
  }, [call]);

  const begin = useCallback((switchAccount = false) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    void open(controller.signal, switchAccount).catch((cause: unknown) => {
      if (controller.signal.aborted || cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "The demo could not open. Try again.");
      setPhase("failed");
    });
  }, [open]);

  useEffect(() => {
    begin();
    return () => active.current?.abort();
  }, [begin]);

  // Back from the project, the page may come from the browser's cache: open the demo again.
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => { if (event.persisted) begin(); };
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  }, [begin]);

  const footer = <>PayPal Sandbox, no real money. <Link className="font-medium text-[var(--primary)]" href="/">Back to Setti</Link></>;

  if (phase === "signed-in") {
    return <Shell title="You're signed in" footer={footer}>
      <p className="text-[13px] leading-relaxed text-slate-600">You are signed in as {signedInAs}. The demo signs this browser in as its own designer, so you would be signed out of your account first.</p>
      <div className="mt-4 space-y-2">
        <Link href="/chats" className={BUTTON}>Back to my projects</Link>
        <button type="button" onClick={() => begin(true)} className="w-full rounded-lg px-4 py-2.5 text-[13px] font-medium text-[var(--primary)] hover:bg-[var(--canvas)]">Sign out and open the demo</button>
      </div>
    </Shell>;
  }

  if (phase === "failed") {
    return <Shell title="The demo didn't open" footer={footer}>
      <p role="alert" className="flex items-start gap-2 text-[13px] leading-relaxed text-red-800"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>
      <p className="mt-2 text-[12px] text-[var(--muted)]">Anything already prepared is saved, so trying again continues from there.</p>
      <button type="button" onClick={() => begin()} className={`${BUTTON} mt-4 gap-1.5`}><RefreshCw className="h-3.5 w-3.5" />Try again</button>
    </Shell>;
  }

  const stages = seed?.stages ?? [];
  const done = stages.filter((stage) => stage.status === "done").length;
  const step = phase === "opening" ? "Opening Maple Ave Café…"
    : stages.find((stage) => stage.status !== "done")?.label.replace(/\.?$/, "…") ?? "Starting your private demo…";
  return <Shell title="Opening the live demo" footer={footer}>
    <p className="text-[13px] leading-relaxed text-slate-600">Maple Ave Café, a sample café refit. You start as Jordan, the designer, and can switch to Emma, the client, from the account menu.</p>
    <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-[var(--canvas)]" aria-hidden="true">
      <div className="h-full rounded-full bg-[var(--primary-fill)] transition-[width] duration-500" style={{ width: `${phase === "opening" ? 100 : stages.length ? Math.max(8, (done / stages.length) * 100) : 8}%` }} />
    </div>
    <p role="status" aria-live="polite" className="mt-2.5 flex items-center gap-1.5 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />{step}</p>
  </Shell>;
}
