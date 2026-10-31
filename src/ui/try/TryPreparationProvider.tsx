"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { HOME_SCENARIO } from "@/demo/living-dining";

export interface PreparationSeed {
  runId: string;
  scenario: string;
  status: "seeding" | "ready" | "failed";
  workspaceReady?: boolean;
  baselineQuoteVersion?: number;
  changeOrderId: string | null;
  busy: boolean;
  canResume: boolean;
  error: string | null;
  stages: { id: string; label: string; status: "pending" | "running" | "done" | "failed" }[];
}

export function canOpenPreparedWorkspace(seed: Pick<PreparationSeed, "scenario" | "status" | "workspaceReady">): boolean {
  return seed.status === "ready" || seed.scenario === HOME_SCENARIO && seed.workspaceReady === true;
}

export function announceTryProgress(seed: PreparationSeed | null) {
  window.dispatchEvent(new CustomEvent("setti:try-progress", { detail: seed }));
}

function savedSeed(value: unknown): PreparationSeed | null {
  if (!value || typeof value !== "object" || !("seed" in value)) throw new Error("The saved payment setup could not be read.");
  const seed = (value as { seed: PreparationSeed | null }).seed;
  if (seed === null) return null;
  if (!seed || typeof seed.runId !== "string" || typeof seed.scenario !== "string" || !["seeding", "ready", "failed"].includes(seed.status) || !Array.isArray(seed.stages)) throw new Error("The saved payment setup is incomplete.");
  return seed;
}

interface PreparationState {
  seed: PreparationSeed | null;
  error: string | null;
  checking: boolean;
  refresh: () => Promise<void>;
  retry: () => void;
}
const PreparationContext = createContext<PreparationState>({ seed: null, error: null, checking: true, refresh: async () => {}, retry: () => {} });

/** Survives route and role changes; a stored run is created only by an explicit entry action. */
export function TryPreparationProvider({ children }: { children: React.ReactNode }) {
  const [seed, setSeed] = useState<PreparationSeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [retryTick, setRetryTick] = useState(0);
  const seedRef = useRef<PreparationSeed | null>(null);
  const retryRun = useRef<string | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);

  const accept = useCallback((next: PreparationSeed | null) => {
    const previous = seedRef.current;
    if (previous === next) return;
    if (previous && next?.runId === previous.runId) {
      if (previous.status === "ready" && next.status !== "ready") return;
      if (previous.stages.filter((stage) => stage.status === "done").length > next.stages.filter((stage) => stage.status === "done").length) return;
    }
    epoch.current++;
    if (previous?.runId !== next?.runId) retryRun.current = null;
    seedRef.current = next;
    setSeed(next);
    setChecking(false);
  }, []);

  const publish = useCallback((next: PreparationSeed | null) => {
    accept(next);
    announceTryProgress(seedRef.current);
  }, [accept]);

  const refresh = useCallback(async () => {
    const startedAt = epoch.current;
    const startedRun = seedRef.current?.runId;
    try {
      const response = await fetch("/api/try", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      if (!mounted.current || startedAt !== epoch.current) return;
      if (!response.ok) throw new Error("The saved payment setup could not be refreshed.");
      const next = savedSeed(body);
      publish(next);
      if (!next || next.status === "ready" || next.runId !== startedRun) setError(null);
    } catch (cause) {
      if (mounted.current && startedAt === epoch.current) setError(cause instanceof Error ? cause.message : "Payment setup could not be reached.");
    } finally { if (mounted.current) setChecking(false); }
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    const selected = (event: Event) => { accept((event as CustomEvent<PreparationSeed | null>).detail); };
    const focused = () => { void refresh(); };
    window.addEventListener("setti:try-progress", selected);
    window.addEventListener("focus", focused);
    void refresh();
    return () => { mounted.current = false; window.removeEventListener("setti:try-progress", selected); window.removeEventListener("focus", focused); };
  }, [accept, refresh]);

  useEffect(() => {
    if (!error || seed?.scenario !== HOME_SCENARIO || seed.status === "ready") return;
    // A lost response may still finish on the server. Read it back without retrying money.
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(timer);
  }, [error, seed?.scenario, seed?.status, refresh]);

  const runId = seed?.runId;
  const workspaceReady = seed?.workspaceReady;
  useEffect(() => {
    const original = seedRef.current;
    if (!original || original.scenario !== HOME_SCENARIO || !original.workspaceReady || original.status === "ready") return;
    if (original.status === "failed" && (retryRun.current !== original.runId || !original.canResume)) return;
    const controller = new AbortController();
    let active = true;
    const pause = () => new Promise<void>((resolve) => {
      const aborted = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { controller.signal.removeEventListener("abort", aborted); resolve(); }, 1_200);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    void (async () => {
      let retryFailed = retryRun.current === original.runId;
      try {
        while (active && seedRef.current?.runId === original.runId) {
          const current = seedRef.current;
          if (current.status === "ready" || current.status === "failed" && (!retryFailed || !current.canResume)) return;
          const busy = current.busy;
          if (busy) await pause();
          if (!active) return;
          const response = await fetch("/api/try", busy ? { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) } : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "prepare", runId: original.runId }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          });
          const body = await response.json().catch(() => null);
          if (!active || seedRef.current?.runId !== original.runId) return;
          const next = savedSeed(body);
          if (next?.runId !== original.runId) throw new Error("Another project was selected. Reload its saved setup before continuing.");
          publish(next);
          if (!busy) { retryFailed = false; retryRun.current = null; }
          if (!response.ok || next.status === "failed") throw new Error(next.error || "Payment setup paused. Your discussion and pricing draft are saved.");
          setError(null);
        }
      } catch (cause) {
        if (active && !(cause instanceof Error && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Payment setup paused. Check the saved progress before retrying.");
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [runId, workspaceReady, retryTick, publish]);

  const retry = useCallback(() => { retryRun.current = seedRef.current?.runId ?? null; setError(null); setRetryTick((value) => value + 1); }, []);
  return <PreparationContext.Provider value={{ seed, error, checking, refresh, retry }}>{children}</PreparationContext.Provider>;
}

export function useTryPreparation() { return useContext(PreparationContext); }
