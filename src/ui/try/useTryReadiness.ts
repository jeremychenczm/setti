"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CaseKey } from "@/chat/types";
import { HOME_SCENARIO } from "@/demo/living-dining";

export const TRY_PAYMENT_SETUP_NOTICE = "Payment setup is continuing in the background. You can keep discussing and reviewing the quote.";
export interface ReadinessSeed {
  runId: string;
  scenario: string;
  status: "seeding" | "ready" | "failed";
}
export interface TryReadiness {
  seed: ReadinessSeed | null;
  checking: boolean;
  pending: boolean;
  blocked: boolean;
  error: string | null;
  notice: string | null;
}

/** Only the current new scenario needs the background preparation gate. */
export function tryReadiness(seed: ReadinessSeed | null, checking = false, error: string | null = null): TryReadiness {
  const pending = seed?.scenario === HOME_SCENARIO && seed.status !== "ready";
  const notice = pending ? seed.status === "failed"
    ? "Payment setup is paused. Resume it from the project guide; you can keep discussing and reviewing the quote."
    : TRY_PAYMENT_SETUP_NOTICE : null;
  return { seed, checking, pending, blocked: checking || pending || Boolean(error && seed === null), error, notice };
}

/** Undefined means malformed data; null is an explicitly absent run. */
export function readinessSeed(value: unknown): ReadinessSeed | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const seed = value as Partial<ReadinessSeed>;
  return typeof seed.runId === "string" && typeof seed.scenario === "string" && ["seeding", "ready", "failed"].includes(seed.status ?? "") ? seed as ReadinessSeed : undefined;
}

const initial = tryReadiness(null, true);
const unrelated = tryReadiness(null);
let current = initial;
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;

function publish(next: TryReadiness) {
  current = next;
  listeners.forEach((listener) => listener());
}
async function refresh() {
  if (!listeners.size || controller) return;
  const requestId = ++generation;
  const request = new AbortController();
  controller = request;
  try {
    const response = await fetch("/api/try", { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) });
    const body: unknown = await response.json().catch(() => null);
    if (requestId !== generation || !listeners.size || request.signal.aborted) return;
    const seed = body && typeof body === "object" && "seed" in body ? readinessSeed(body.seed) : undefined;
    if (!response.ok || seed === undefined) throw new Error("Payment setup status could not be checked. Reload to check its saved progress.");
    publish(tryReadiness(seed));
  } catch {
    if (requestId === generation && listeners.size && !request.signal.aborted) publish(tryReadiness(current.seed, false, "Payment setup status could not be checked. Reload to check its saved progress."));
  } finally {
    if (controller === request) controller = null;
  }
}
function onProgress(event: Event) {
  const seed = readinessSeed((event as CustomEvent<unknown>).detail);
  if (seed === undefined) return;
  generation++;
  publish(tryReadiness(seed));
}
const onFocus = () => { void refresh(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("setti:try-progress", onProgress);
    window.addEventListener("focus", onFocus);
    timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5_000);
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("setti:try-progress", onProgress);
      window.removeEventListener("focus", onFocus);
      if (timer) clearInterval(timer);
      timer = null;
      generation++;
      controller?.abort();
      controller = null;
      current = initial;
    }
  };
}

/** Read-only status shared by the payment widgets; it never starts preparation. */
export function useTryReadiness(projectKey: CaseKey): TryReadiness {
  const listen = useCallback((listener: () => void) => projectKey === "maple" ? subscribe(listener) : () => {}, [projectKey]);
  const snapshot = useCallback(() => projectKey === "maple" ? current : unrelated, [projectKey]);
  const serverSnapshot = useCallback(() => projectKey === "maple" ? initial : unrelated, [projectKey]);
  return useSyncExternalStore(listen, snapshot, serverSnapshot);
}
