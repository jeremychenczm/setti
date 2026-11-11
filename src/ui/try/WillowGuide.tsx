"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseSnapshot } from "@/chat/types";
import type { ItemHoldsView } from "@/payments/item-holds-view";
import type { ServicesPaymentView } from "@/payments/services-view";
import { GUIDE_TOOL, GuideBar } from "./GuideBar";
import { useDemoSkip } from "./useDemoSkip";
import type { TrySeedNoticeProps } from "./TrySeedNotice";
import { navigateGuidePage, useGuideAnchor } from "./useGuideAnchor";
import { WILLOW_GUIDE_STEPS, willowGuideStep, type WillowGuideData } from "./willow-guide";

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("The guide could not read the saved Willow records.");
  return body;
}

/**
 * The opening-quote walkthrough uses the normal signing, wallet and item-payment
 * screens. It shows where the walkthrough stands, the one next step and a way
 * to end the demo; the account and demo home live in the sidebar's account menu.
 */
export function WillowGuide({ account, onSwitchAccount, onOpenChat, currentView, currentOrderId }: TrySeedNoticeProps) {
  const [data, setData] = useState<WillowGuideData | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useGuideAnchor(data !== null);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    try {
      const workspace = await readJson("/api/try", controller.signal) as { hasWorkspace?: boolean } | null;
      if (!workspace?.hasWorkspace) { setData(null); setError(null); return; }
      const snapshot = await readJson("/api/chat/willow", controller.signal) as CaseSnapshot;
      if (snapshot.projectKey !== "willow" || !snapshot.opening?.progress || !Array.isArray(snapshot.versions)) throw new Error("Incomplete Willow snapshot");
      const [services, holds] = snapshot.opening.progress.approved > 0 ? await Promise.all([
        readJson("/api/quotes/willow/services-payment", controller.signal).then((value) => value as ServicesPaymentView).catch(() => null),
        readJson("/api/quotes/willow/item-holds", controller.signal).then((value) => value as ItemHoldsView).catch(() => null),
      ]) : [null, null];
      if (controller.signal.aborted) return;
      const validServices = services?.projectKey === "willow" && Array.isArray(services.services) ? services : null;
      const validHolds = holds?.projectKey === "willow" && Array.isArray(holds.items) ? holds : null;
      setData({ snapshot, services: validServices, holds: validHolds });
      setViewerId(account.id);
      setError(snapshot.opening.progress.approved > 0 && (!validServices || !validHolds) ? "Some payment records could not be read. Inspect the saved quote status before repeating a payment." : null);
    } catch {
      if (!controller.signal.aborted) setError("The guide could not refresh. Your existing decisions and payments are not changed by this check.");
    } finally {
      if (request.current === controller) busy.current = false;
    }
  }, [account.id]);

  useEffect(() => {
    void refresh();
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(update, 5_000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); request.current?.abort(); busy.current = false; };
  }, [refresh]);

  if (!data || viewerId !== account.id) return null;
  return <WillowGuideBar data={data} account={account} onSwitchAccount={onSwitchAccount} onOpenChat={onOpenChat} currentView={currentView} currentOrderId={currentOrderId} refresh={refresh} error={error} />;
}

function WillowGuideBar({ data, account, onSwitchAccount, onOpenChat, currentView, currentOrderId, refresh, error: loadError }: Omit<TrySeedNoticeProps, "projectKey"> & { data: WillowGuideData; refresh: () => Promise<void>; error: string | null }) {
  const { skipping, skip, error: skipError } = useDemoSkip("willow", refresh);
  const error = skipError ?? loadError;
  const step = willowGuideStep(data, account.role);
  const switchNeeded = step.role !== account.id;
  const nextName = step.role === "sofia" ? "Sofia" : "Jordan";
  const sameQuote = step.destination === "quote" && currentView === "quotes" && !switchNeeded;
  const sameOrder = step.destination === "order" && currentView === "change-order" && currentOrderId === step.orderId && !switchNeeded;
  const action = switchNeeded ? `Continue as ${nextName}` : step.skipTo ? step.action : sameQuote || sameOrder ? step.anchor === "client-decision-title" ? "Go to client review below" : step.anchor ? "Go to the payment section below" : step.action : step.action;

  function continueGuide() {
    if (skipping) return;
    if (step.skipTo && !switchNeeded) { void skip(step.skipTo); return; }
    const path = step.destination === "chat" ? "/chats/willow" : step.destination === "order" ? `/change-orders/${step.orderId}` : "/quotes/willow";
    if (switchNeeded) { void onSwitchAccount(step.role, `${path}${step.anchor && step.destination !== "chat" ? `#${step.anchor}` : ""}`); return; }
    if (step.destination === "chat") { onOpenChat(); return; }
    if (sameQuote || sameOrder) {
      if (step.anchor) document.getElementById(step.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
      else document.querySelector<HTMLElement>('[aria-label="Search quote items"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    navigateGuidePage(`${path}${step.anchor ? `#${step.anchor}` : ""}`, false);
  }

  const days = data.holds?.clock.simulatedDays ?? 0;
  return <GuideBar label="Willow demo guide" steps={WILLOW_GUIDE_STEPS} step={step} action={skipping ? "Running each day's check…" : action} onAction={continueGuide} error={error} busy={skipping}
    tools={days > 0 ? <span className={GUIDE_TOOL} title="Simulated time: Setti judges holds as if this many days had passed. PayPal calls still happen now, in the Sandbox.">Simulated time · day {days}</span> : undefined}>
    {step.secondary && !switchNeeded && <a href={step.secondary.href} className="mt-1.5 inline-flex text-[11px] font-medium text-brand-700 underline underline-offset-2">{step.secondary.label}</a>}
  </GuideBar>;
}
