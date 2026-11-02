"use client";

import { useCallback, useState } from "react";
import type { CaseKey } from "@/chat/types";
import { paymentChanged } from "../payments/usePaymentRefresh";

/**
 * Skips a demo session's simulated time ahead: the server runs the daily check
 * for each day passed. Afterwards the guide reloads, and every payment section
 * and the reminders refresh. PayPal calls the checks make are real Sandbox calls.
 */
export function useDemoSkip(projectKey: CaseKey, reload: () => Promise<void>) {
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skip = useCallback(async (days: number) => {
    setSkipping(true); setError(null);
    try {
      const response = await fetch("/api/demo/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
      const body = await response.json().catch(() => null) as { error?: string; problems?: string[] } | null;
      if (!response.ok) throw new Error(body?.error ?? "The demo could not skip ahead.");
      if (body?.problems?.length) setError(`The daily check reported: ${body.problems[0]}`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The demo could not skip ahead.");
    } finally {
      setSkipping(false);
      paymentChanged(projectKey);
    }
  }, [projectKey, reload]);
  return { skipping, skip, error };
}

/** The demo day a guide skips to: three days on, PayPal's honor period is over and the not-ordered reminder appears. */
export const NOT_ORDERED_SKIP = 3;
