"use client";

import { useCallback, useEffect, useState } from "react";

const PAYMENT_CHANGED = "setti:payment-changed";
/** The inbox marked what it showed as seen. */
export const INBOX_SEEN = "setti:inbox-seen";
/** The demo's background preparation saved a step, such as a starting payment. */
const TRY_PROGRESS = "setti:try-progress";
const EVERY_MS = 60_000;

/**
 * The number on the sidebar's Inbox: the designer's open reminders, or the
 * client's money records not seen yet. Read when the workspace opens, every
 * minute, when the window regains focus, and after any payment step, demo
 * preparation step or inbox visit. A failed read keeps the last number.
 */
export function useInboxBadge(accountId: string): number {
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/inbox/badge", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as { count?: number };
      if (typeof body.count === "number") setCount(body.count);
    } catch { /* keep the last number */ }
  }, []);

  useEffect(() => {
    setCount(0);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, EVERY_MS);
    const refresh = () => { void load(); };
    const events = [PAYMENT_CHANGED, INBOX_SEEN, TRY_PROGRESS, "focus"];
    for (const name of events) window.addEventListener(name, refresh);
    return () => {
      window.clearInterval(timer);
      for (const name of events) window.removeEventListener(name, refresh);
    };
  }, [accountId, load]);
  return count;
}
