"use client";

import { useCallback, useEffect, useState } from "react";
import type { AttentionView } from "@/payments/attention-view";

const PAYMENT_CHANGED = "setti:payment-changed";
const EVERY_MS = 60_000;

/**
 * The designer's reminders: read when the workspace opens, every minute, when
 * the window regains focus, and after any payment step on any project.
 */
export function useAttention(enabled: boolean): { view: AttentionView | null; error: string | null } {
  const [view, setView] = useState<AttentionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch("/api/attention", { cache: "no-store" });
      if (!response.ok) throw new Error(`Reminders could not be loaded (${response.status}).`);
      setView(await response.json() as AttentionView);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reminders could not be loaded."); }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setView(null); return; }
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, EVERY_MS);
    const refresh = () => { void load(); };
    window.addEventListener(PAYMENT_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PAYMENT_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, load]);
  return { view, error };
}
