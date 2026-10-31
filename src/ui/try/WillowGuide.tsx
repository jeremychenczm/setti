"use client";

import { ArrowRight, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountId } from "@/accounts/demo";
import type { CaseSnapshot } from "@/chat/types";
import type { ItemHoldsView } from "@/payments/item-holds-view";
import type { ServicesPaymentView } from "@/payments/services-view";
import { EndDemoButton } from "./EndDemoButton";
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
  const [viewerId, setViewerId] = useState<AccountId | null>(null);
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
  const step = willowGuideStep(data, account.role);
  const switchNeeded = step.role !== account.id;
  const nextName = step.role === "sofia" ? "Sofia" : "Jordan";
  const sameQuote = step.destination === "quote" && currentView === "quotes" && !switchNeeded;
  const sameOrder = step.destination === "order" && currentView === "change-order" && currentOrderId === step.orderId && !switchNeeded;
  const action = switchNeeded ? `Continue as ${nextName}` : sameQuote || sameOrder ? step.anchor === "client-decision-title" ? "Go to client review below" : step.anchor ? "Go to the payment section below" : step.action : step.action;

  function continueGuide() {
    if (switchNeeded) onSwitchAccount(step.role);
    if (step.destination === "chat") { onOpenChat(); return; }
    if (sameQuote || sameOrder) {
      if (step.anchor) document.getElementById(step.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
      else document.querySelector<HTMLElement>('[aria-label="Search quote items"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const path = step.destination === "order" ? `/change-orders/${step.orderId}` : "/quotes/willow";
    navigateGuidePage(`${path}${step.anchor ? `#${step.anchor}` : ""}`, switchNeeded);
  }

  const done = (index: number) => index < step.index || (index === step.index && !!step.complete);
  return <aside aria-label="Willow demo guide" className="shrink-0 rounded-xl border border-[var(--primary-line)] bg-[var(--primary-soft)] px-4 py-3 text-[var(--ink)]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <ol aria-label={`Step ${step.index + 1} of ${WILLOW_GUIDE_STEPS.length}`} className="flex flex-1 flex-wrap items-center gap-1.5">
      {WILLOW_GUIDE_STEPS.map((label, index) => <li key={label} title={label} aria-current={step.index === index ? "step" : undefined} className="flex items-center gap-1.5">
        {index > 0 && <span aria-hidden className={`h-px w-4 sm:w-6 ${index <= step.index ? "bg-[var(--primary)]" : "bg-[var(--primary-line)]"}`} />}
        <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-semibold ${done(index) ? "bg-[var(--primary)] text-white" : index === step.index ? "border-2 border-[var(--primary)] bg-white text-[var(--primary)]" : "border border-[var(--primary-line)] bg-white text-[var(--muted)]"}`}>
          {done(index) ? <Check className="h-2.5 w-2.5" /> : index + 1}<span className="sr-only">{label}</span>
        </span>
      </li>)}
      <li className="ml-1.5 text-[10px] text-[var(--muted)]">Step {step.index + 1} of {WILLOW_GUIDE_STEPS.length} · {WILLOW_GUIDE_STEPS[step.index]}</li>
    </ol>
    <EndDemoButton className="rounded-md px-1.5 py-1 text-[10px] font-medium text-brand-700 hover:bg-brand-100" />
    </div>
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-[220px] flex-1">
        <h2 className="text-[13px] font-semibold leading-snug">{step.title}</h2>
        <p title={step.detail} className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-600">{step.detail}</p>
      </div>
      <button type="button" onClick={continueGuide} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">{action}<ArrowRight className="h-3.5 w-3.5" /></button>
    </div>
    {error && <p role="status" className="mt-2 text-[10px] leading-relaxed text-amber-800">{error}</p>}
  </aside>;
}
