"use client";

import { ArrowRight, Check, ChevronDown, ChevronUp, FileText, LoaderCircle, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AccountId } from "@/accounts/demo";
import type { CaseSnapshot } from "@/chat/types";
import type { ItemHoldsView } from "@/payments/item-holds-view";
import type { ServicesPaymentView } from "@/payments/services-view";
import { money } from "../pricing/common";
import type { TrySeedNoticeProps } from "./TrySeedNotice";
import { navigateGuidePage, useGuideAnchor } from "./useGuideAnchor";
import { WILLOW_GUIDE_STEPS, willowGuideStep, type WillowGuideData } from "./willow-guide";

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("The guide could not read the saved Willow records.");
  return body;
}

/** The opening-quote walkthrough uses the normal signing, wallet and item-payment screens. */
export function WillowGuide({ account, onSwitchAccount, onOpenChat, currentView, currentOrderId }: TrySeedNoticeProps) {
  const [data, setData] = useState<WillowGuideData | null>(null);
  const [viewerId, setViewerId] = useState<AccountId | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsId = useId();
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useGuideAnchor(data !== null);

  const refresh = useCallback(async (manual = false) => {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    if (manual) setLoading(true);
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
      if (request.current === controller) { busy.current = false; setLoading(false); }
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
  const progress = data.snapshot.opening.progress;
  const capturedItems = data.holds?.items.filter((item) => item.state === "captured").length ?? 0;
  const coveredItems = data.holds?.items.filter((item) => ["captured", "confirmed", "held"].includes(item.state)).length ?? 0;

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

  return <aside aria-label="Willow demo guide" className="shrink-0 rounded-xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-slate-700">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold text-violet-950"><FileText className="h-3.5 w-3.5 shrink-0" />Willow Residence · from the first quote</p>
      <Link href="/try" className="text-[10px] font-medium text-violet-700 underline underline-offset-2">Demo home</Link>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white px-2.5 py-1 text-[10px]"><UserRound className="h-3 w-3" />You are {account.name} · {account.role === "designer" ? "Designer" : "Client"}</span>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailsId} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-violet-700 hover:bg-violet-100">{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{expanded ? "Hide details" : "Show steps and status"}</button>
      <button type="button" onClick={() => void refresh(true)} disabled={loading} aria-label="Refresh Willow guide from saved records" className="rounded-md p-1 text-violet-700 hover:bg-violet-100 disabled:opacity-50">{loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-3"><h2 className="min-w-0 flex-1 text-[12px] font-semibold text-slate-900"><span className="mr-1.5 font-normal text-slate-500">{step.index + 1}/{WILLOW_GUIDE_STEPS.length}</span>{step.title}</h2><button type="button" onClick={continueGuide} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[11px] font-semibold text-white hover:bg-blue-600">{action}<ArrowRight className="h-3 w-3" /></button></div>
    <div id={detailsId} hidden={!expanded} className="mt-2 max-h-[28dvh] overflow-y-auto pr-1">
      <ol aria-label="Willow progress from saved records" className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">{WILLOW_GUIDE_STEPS.map((label, index) => <li key={label} aria-current={step.index === index ? "step" : undefined} className={`flex items-center gap-1 ${step.index === index ? "font-semibold text-violet-800" : ""}`}>{index < step.index || (index === step.index && step.complete) ? <Check className="h-3 w-3 text-emerald-700" /> : <span>{index + 1}.</span>}{label}</li>)}</ol>
      <p className="mt-2 max-w-4xl text-[11px] leading-relaxed">{step.detail}</p>
      <dl className="mt-3 grid gap-2 text-[10px] sm:grid-cols-3">
        <div className="rounded-lg border border-violet-100 bg-white p-2.5"><dt className="font-semibold text-slate-800">Saved V1 decisions</dt><dd className="mt-1">{progress.approved} approved · {progress.declined} declined · {progress.pending} undecided</dd></div>
        <div className="rounded-lg border border-violet-100 bg-white p-2.5"><dt className="font-semibold text-slate-800">Approved service payments</dt><dd className="mt-1">{data.services?.services.length ? `${money(data.services.dueCents)} not yet completed` : "No approved service payment loaded"}</dd><dd className="mt-1">{data.services?.savedPayPal ? "Saved PayPal recorded" : "Saved PayPal not recorded"}</dd></div>
        <div className="rounded-lg border border-violet-100 bg-white p-2.5"><dt className="font-semibold text-slate-800">Approved furniture</dt><dd className="mt-1">{data.holds ? `${coveredItems} of ${data.holds.items.length} held or captured · ${capturedItems} captured` : "Item payment records not loaded"}</dd></div>
      </dl>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">Prepared demo materials: the 28-line quote, suppliers, products and prices are fictional. Your signatures and new PayPal Sandbox actions are taken through the normal screens, not pre-filled by this guide. Supplier confirmations are designer-entered demo records. Sandbox payments move no real money. You can start with a few lines; there is no requirement to approve the whole quote.</p>
    </div>
    {error && <p role="status" className="mt-2 text-[10px] leading-relaxed text-amber-800">{error}</p>}
  </aside>;
}
