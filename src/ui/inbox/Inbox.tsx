"use client";

import { useCallback, useEffect, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { InboxView } from "@/payments/inbox-view";
import { INBOX_SEEN } from "../workspace/useInboxBadge";
import { ClientInbox } from "./ClientInbox";
import { DesignerInbox } from "./DesignerInbox";
import { InboxFrame, Loading } from "./parts";

const PAYMENT_CHANGED = "setti:payment-changed";

/** What the inbox showed is no longer new; the sidebar's number follows. */
async function markSeen(view: InboxView) {
  try {
    const response = await fetch("/api/inbox/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ through: view.readAt }) });
    if (response.ok) window.dispatchEvent(new Event(INBOX_SEEN));
  } catch { /* still new; the next visit marks it */ }
}

/**
 * The payment inbox. Setti watches every project's money: the designer sees
 * what needs doing, project by project, the client sees where their money
 * stands, item by item, each record with when PayPal last confirmed it. Setti's
 * summary beside it is written by the model from the same records and checked
 * against them before it is shown. Records that arrived since the reader's last
 * visit are marked New for as long as the inbox stays open; on a first visit
 * nothing is, since everything would be.
 */
export function Inbox({ account }: { account: DemoAccount }) {
  const [view, setView] = useState<InboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [firstVisit, setFirstVisit] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/inbox", { cache: "no-store" });
      if (!response.ok) throw new Error(`The inbox could not be loaded (${response.status}).`);
      const next = await response.json() as InboxView;
      setView(next); setError(null);
      setFirstVisit((current) => current ?? !next.opened);
      if (next.opened && next.unread.length) setFresh((current) => new Set([...current, ...next.unread]));
      void markSeen(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The inbox could not be loaded."); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    window.addEventListener(PAYMENT_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener(PAYMENT_CHANGED, refresh); window.removeEventListener("focus", refresh); };
  }, [load]);

  if (!view) return <InboxFrame subtitle={account.role === "designer" ? "Setti watches the money in every project and tells you what needs you." : "Where your money stands, as PayPal records it."} error={error}>
    {!error && <Loading />}
  </InboxFrame>;
  return view.role === "designer"
    ? <DesignerInbox view={view} fresh={fresh} error={error} />
    : <ClientInbox view={view} fresh={fresh} firstVisit={firstVisit ?? !view.opened} error={error} />;
}
