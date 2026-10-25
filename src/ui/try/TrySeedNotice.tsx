"use client";

import { ArrowRight, Check, ChevronDown, ChevronUp, Copy, CreditCard, LoaderCircle, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseSnapshot } from "@/chat/types";
import type { PaymentsWorkspace } from "@/payments/types";
import type { PricingWorkspace } from "@/pricing/types";
import { money } from "../pricing/common";
import { lineProgress } from "../payments/progress";
import { MAPLE_EXAMPLE_REQUEST, MAPLE_GUIDE_STEPS, mapleChangeLines, mapleGuideStep, type MapleGuideData } from "./maple-guide";
import { navigateGuidePage, useGuideAnchor } from "./useGuideAnchor";
import { WillowGuide } from "./WillowGuide";

export interface TrySeedNoticeProps {
  projectKey: CaseKey;
  account: DemoAccount;
  onSwitchAccount: (id: AccountId) => void;
  onOpenChat: () => void;
  currentView: "chats" | "quotes" | "pricing" | "change-order";
  currentOrderId?: string;
}

interface ReadySeed { status: "ready"; changeOrderId: string }

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("The guide could not refresh the saved project records.");
  return body;
}

function readySeed(value: unknown): ReadySeed | null {
  const seed = (value as { seed?: Partial<ReadySeed> } | null)?.seed;
  return seed?.status === "ready" && typeof seed.changeOrderId === "string" && /^[0-9a-f-]{36}$/i.test(seed.changeOrderId) ? seed as ReadySeed : null;
}

/** A read-only guide; switching roles and following links never signs or moves money. */
export function TrySeedNotice(props: TrySeedNoticeProps) {
  return props.projectKey === "willow" ? <WillowGuide {...props} /> : <MapleSeedNotice {...props} />;
}

function MapleSeedNotice({ projectKey, account, onSwitchAccount, onOpenChat, currentView, currentOrderId }: TrySeedNoticeProps) {
  const [data, setData] = useState<MapleGuideData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [viewerId, setViewerId] = useState<AccountId | null>(null);
  const detailsId = useId();
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useGuideAnchor(projectKey === "maple" && data !== null);

  const refresh = useCallback(async (manual = false) => {
    if (projectKey !== "maple" || busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    if (manual) setLoading(true);
    try {
      const seed = readySeed(await readJson("/api/try", controller.signal));
      if (!seed) { setData(null); setError(null); return; }
      const snapshot = await readJson("/api/chat/maple", controller.signal) as CaseSnapshot;
      if (snapshot.projectKey !== "maple" || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.versions)) throw new Error("The guide received incomplete project records.");
      const approved = [...snapshot.versions].filter((version) => version.status === "approved").sort((a, b) => b.version - a.version)[0];
      const paymentOrderId = approved?.id ?? seed.changeOrderId;
      const [pricing, payments] = await Promise.all([
        account.role === "designer" ? readJson("/api/pricing/maple", controller.signal).then((value) => value as PricingWorkspace).catch(() => null) : Promise.resolve(null),
        readJson(`/api/change-orders/${encodeURIComponent(paymentOrderId)}/payments`, controller.signal).then((value) => value as PaymentsWorkspace).catch(() => null),
      ]);
      if (controller.signal.aborted) return;
      const validPayments = payments?.orderId === paymentOrderId && Array.isArray(payments.lines) && Array.isArray(payments.operations) ? payments : null;
      const formStale = currentView === "pricing" ? document.getElementById("pricing-workspace")?.getAttribute("data-pricing-source-stale") : null;
      setData({ seedOrderId: seed.changeOrderId, snapshot, pricing: pricing?.projectKey === "maple" ? pricing : null, payments: validPayments,
        pricingViewStale: formStale === "true" ? true : formStale === "false" ? false : undefined });
      setViewerId(account.id);
      setError(validPayments ? null : "Payment records could not be refreshed. Open the version to check its saved status.");
    } catch {
      if (!controller.signal.aborted) setError("The guide could not refresh. Check the saved project status before repeating an action.");
    } finally {
      if (request.current === controller) { busy.current = false; setLoading(false); }
    }
  }, [projectKey, account.id, account.role, currentView]);

  useEffect(() => {
    if (projectKey !== "maple") return;
    void refresh();
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(update, 5_000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); request.current?.abort(); busy.current = false; };
  }, [projectKey, refresh]);

  if (projectKey !== "maple" || !data || viewerId !== account.id) return null;
  const step = mapleGuideStep(data, account.role);
  const switchNeeded = account.id !== step.role;
  const nextName = step.role === "emma" ? "Emma" : "Jordan";
  const currentDestination = !switchNeeded && ((step.destination === "chat" && currentView === "chats") || (step.destination === "pricing" && currentView === "pricing") || (step.destination === "order" && currentView === "change-order" && currentOrderId === step.orderId));
  const action = switchNeeded ? `Continue as ${nextName}` : currentDestination ? step.destination === "pricing" ? step.anchor === "pricing-source-status" ? step.action : "Continue pricing below" : step.destination === "order" ? step.anchor === "payments" ? "Go to payments below" : "Go to client review below" : step.action : step.action;
  const outcomes = data.payments && data.payments.orderId !== data.seedOrderId ? mapleChangeLines(data.payments) : [];

  function continueGuide() {
    if (switchNeeded) onSwitchAccount(step.role);
    if (step.destination === "chat") {
      onOpenChat();
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project message"]')?.focus());
    } else if (currentDestination) {
      if (step.destination === "pricing") {
        const notice = step.anchor ? document.getElementById(step.anchor) : null;
        (notice ?? document.querySelector<HTMLElement>('input[aria-label="Client change-order title"]'))?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      else document.getElementById(step.anchor ?? "payments")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      navigateGuidePage(step.destination === "pricing" ? `/pricing/maple${step.anchor ? `#${step.anchor}` : ""}` : `/change-orders/${step.orderId}${step.anchor ? `#${step.anchor}` : ""}`, switchNeeded);
    }
  }

  async function copyRequest() {
    try { await navigator.clipboard.writeText(MAPLE_EXAMPLE_REQUEST); setCopied(true); }
    catch { setCopied(false); setError("Copy is unavailable here. You can select the example text below and paste it into the chat."); }
  }

  return <aside aria-label="Maple demo guide" className="shrink-0 rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-slate-700">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold text-blue-950"><CreditCard className="h-3.5 w-3.5 shrink-0" />Maple Ave · a change after money moved</p>
      <Link href="/try" className="text-[10px] font-medium text-blue-700 underline underline-offset-2">Demo home</Link>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-100 bg-white px-2.5 py-1 text-[10px]"><UserRound className="h-3 w-3" />You are {account.name} · {account.role === "designer" ? "Designer" : "Client"}</span>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailsId} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-blue-700 hover:bg-blue-100">{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{expanded ? "Hide details" : "Show steps and money"}</button>
      <button type="button" onClick={() => void refresh(true)} disabled={loading} aria-label="Refresh demo guide from saved records" className="rounded-md p-1 text-blue-700 hover:bg-blue-100 disabled:opacity-50">{loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1"><h2 className="text-[12px] font-semibold text-slate-900"><span className="mr-1.5 font-normal text-slate-500">{step.index + 1}/{MAPLE_GUIDE_STEPS.length}</span>{step.title}</h2></div>
      <button type="button" onClick={continueGuide} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[11px] font-semibold text-white hover:bg-blue-600">{action}<ArrowRight className="h-3 w-3" /></button>
    </div>
    <div id={detailsId} hidden={!expanded} className="mt-2 max-h-[28dvh] overflow-y-auto pr-1">
    <ol aria-label="Demo progress from saved records" className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
      {MAPLE_GUIDE_STEPS.map((label, index) => <li key={label} aria-current={index === step.index ? "step" : undefined} className={`flex items-center gap-1 ${index === step.index ? "font-semibold text-blue-800" : ""}`}>{index < step.index || (index === step.index && step.complete) ? <Check className="h-3 w-3 text-emerald-700" /> : <span>{index + 1}.</span>}{label}</li>)}
    </ol>
    <p className="mt-2 max-w-4xl text-[11px] leading-relaxed">{step.detail}</p>
    {outcomes.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-3">
      {outcomes.map((line) => {
        const progress = lineProgress(line, data.payments!.operations);
        const href = `/change-orders/${data.payments!.orderId}#payment-line-${line.side}-${line.itemId}`;
        const result = line.side === "baseline" && line.change === "replace" ? `Released ${money(line.releasedCents)} · still held ${money(line.heldCents)}` : line.change === "remove" ? `Refunded ${money(line.refundedCents)} · retained target ${money(line.targetCents)}` : `Captured ${money(line.capturedCents)} · held ${money(line.heldCents)}`;
        return <Link href={href} key={`${line.side}:${line.itemId}`} className="min-w-0 rounded-lg border border-blue-100 bg-white px-3 py-2 hover:border-blue-300"><p className="truncate text-[11px] font-semibold text-slate-800">{line.label}{line.change === "replace" ? line.side === "baseline" ? " · old item" : " · replacement" : ""}</p><p className={`mt-1 text-[10px] font-medium ${progress.settled ? "text-emerald-700" : "text-amber-800"}`}>{progress.label}</p><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{result}</p></Link>;
      })}
    </div>}
    <details className="mt-2.5 text-[10px] leading-relaxed text-slate-500"><summary className="w-fit cursor-pointer font-medium text-blue-800">Starting story, example request and what is real</summary>
      <p className="mt-2">Prepared starting point: Emma confirmed V2; the lounge chair has an $800 hold and the wool rug has a completed $300 payment. These starting transactions were created on PayPal Sandbox with a test card. They are history prepared for this demo, not actions you just took.</p>
      <Link href={`/change-orders/${data.seedOrderId}#payments`} className="mt-1 inline-block font-medium text-[var(--primary)] underline">Inspect the prepared V2 payment records</Link>
      <div className="mt-2 rounded-lg border border-blue-100 bg-white p-2.5"><p className="select-text text-[11px] text-slate-700">{MAPLE_EXAMPLE_REQUEST}</p><button type="button" onClick={() => void copyRequest()} className="mt-2 inline-flex items-center gap-1 font-medium text-blue-700"><Copy className="h-3 w-3" />{copied ? "Copied · paste and send when ready" : "Copy example request"}</button></div>
      <p className="mt-2">The initial AI draft and prior demo decisions are scripted. Your new @AI requests use the configured model; supplier confirmations and credits are designer-entered demo records. You still review prices, sign the client version and confirm each money action yourself. No real money moves. The cards above cover this change, not the whole project&rsquo;s settlement.</p>
    </details>
    </div>
    {error && <p role="status" className="mt-2 text-[10px] leading-relaxed text-amber-800">{error}</p>}
  </aside>;
}
