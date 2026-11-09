"use client";

import { Check, ChevronDown, ChevronUp, Copy, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseSnapshot } from "@/chat/types";
import type { PaymentsWorkspace } from "@/payments/types";
import type { PricingWorkspace } from "@/pricing/types";
import { HOME_DESIGNER_REQUEST, HOME_SCENARIO, isHomeScenario } from "@/demo/living-dining";
import { money } from "../pricing/common";
import { OPEN_FIRST_CHANGE_EVENT } from "../pricing/ChangeDrawer";
import { lineProgress } from "../payments/progress";
import { HOME_GUIDE_STEPS, MAPLE_EXAMPLE_REQUEST, MAPLE_GUIDE_STEPS, mapleChangeLines, mapleGuideStep, type MapleGuideData } from "./maple-guide";
import { navigateGuidePage, useGuideAnchor } from "./useGuideAnchor";
import { WillowGuide } from "./WillowGuide";
import { GUIDE_TOOL, GuideBar } from "./GuideBar";
import { useDemoSkip } from "./useDemoSkip";
import { canOpenPreparedWorkspace, useTryPreparation } from "./TryPreparationProvider";
import { paymentQuestionHref } from "../chat/payment-question";
import { INBOX_SEEN } from "../workspace/useInboxBadge";

export interface TrySeedNoticeProps {
  projectKey: CaseKey;
  account: DemoAccount;
  onSwitchAccount: (id: AccountId) => void;
  onOpenChat: () => void;
  /** Shows the inbox in the current workspace; without it the guide opens the inbox page. */
  onOpenInbox?: () => void;
  currentView: "chats" | "quotes" | "pricing" | "change-order" | "inbox";
  currentOrderId?: string;
}

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("The guide could not refresh the saved project records.");
  return body;
}

/** A read-only guide; switching roles and following links never signs or moves money. */
export function TrySeedNotice(props: TrySeedNoticeProps) {
  return props.projectKey === "willow" ? <WillowGuide {...props} /> : <MapleSeedNotice {...props} />;
}

function MapleSeedNotice({ projectKey, account, onSwitchAccount, onOpenChat, onOpenInbox, currentView, currentOrderId }: TrySeedNoticeProps) {
  const preparation = useTryPreparation();
  const seed = preparation.seed;
  const [data, setData] = useState<MapleGuideData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [viewerId, setViewerId] = useState<AccountId | null>(null);
  const detailsId = useId();
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useGuideAnchor(projectKey === "maple" && data !== null);
  const reload = useCallback(async () => { busy.current = false; await refreshRef.current(); }, []);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const { skipping, skip, error: skipError } = useDemoSkip("maple", reload);

  const refresh = useCallback(async () => {
    if (projectKey !== "maple" || busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    try {
      if (!seed || !canOpenPreparedWorkspace(seed)) { setData(null); setError(null); return; }
      const snapshot = await readJson("/api/chat/maple", controller.signal) as CaseSnapshot;
      if (snapshot.projectKey !== "maple" || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.versions)) throw new Error("The guide received incomplete project records.");
      const approved = [...snapshot.versions].filter((version) => version.status === "approved").sort((a, b) => b.version - a.version)[0];
      const paymentOrderId = approved?.id ?? seed.changeOrderId;
      const [pricing, payments, clock, inbox] = await Promise.all([
        account.role === "designer" ? readJson("/api/pricing/maple", controller.signal).then((value) => value as PricingWorkspace).catch(() => null) : Promise.resolve(null),
        paymentOrderId ? readJson(`/api/change-orders/${encodeURIComponent(paymentOrderId)}/payments`, controller.signal).then((value) => value as PaymentsWorkspace).catch(() => null) : Promise.resolve(null),
        readJson("/api/demo/clock", controller.signal).then((value) => value as { days?: number }).catch(() => null),
        account.role === "client" ? readJson("/api/inbox/badge", controller.signal).then((value) => value as { opened?: boolean; count?: number }).catch(() => null) : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      const validPayments = payments?.orderId === paymentOrderId && Array.isArray(payments.lines) && Array.isArray(payments.operations) ? payments : null;
      const formStale = currentView === "pricing" ? document.getElementById("pricing-workspace")?.getAttribute("data-pricing-source-stale") : null;
      setData({ seedOrderId: seed.changeOrderId, scenario: seed.scenario, preparationPending: seed.scenario === HOME_SCENARIO && seed.status !== "ready", snapshot, pricing: pricing?.projectKey === "maple" ? pricing : null, payments: validPayments,
        pricingViewStale: formStale === "true" ? true : formStale === "false" ? false : undefined, simulatedDays: typeof clock?.days === "number" ? clock.days : 0,
        clientInboxOpened: typeof inbox?.opened === "boolean" ? inbox.opened : undefined, clientUnread: typeof inbox?.count === "number" ? inbox.count : undefined });
      setViewerId(account.id);
      setError(!paymentOrderId || validPayments ? null : "Payment records could not be refreshed. Open the version to check its saved status.");
    } catch {
      if (!controller.signal.aborted) setError("The guide could not refresh. Check the saved project status before repeating an action.");
    } finally {
      if (request.current === controller) busy.current = false;
    }
  }, [projectKey, account.id, account.role, currentView, seed]);

  refreshRef.current = refresh;
  useEffect(() => {
    if (projectKey !== "maple") return;
    void refresh();
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(update, 5_000);
    window.addEventListener("focus", update);
    window.addEventListener(INBOX_SEEN, update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener(INBOX_SEEN, update); request.current?.abort(); busy.current = false; };
  }, [projectKey, refresh]);

  if (projectKey !== "maple" || !data || viewerId !== account.id) return <PaymentSetupNotice />;
  const step = mapleGuideStep(data, account.role);
  const home = isHomeScenario(data.scenario);
  const startingVersion = seed?.baselineQuoteVersion ?? (data.seedOrderId ? 2 : 1);
  const guideSteps = home ? HOME_GUIDE_STEPS : MAPLE_GUIDE_STEPS;
  const exampleRequest = home ? HOME_DESIGNER_REQUEST : MAPLE_EXAMPLE_REQUEST;
  const switchNeeded = account.id !== step.role;
  const nextName = step.role === "emma" ? "Emma" : "Jordan";
  const changeCount = data.pricing?.review?.input.changes.length ?? 0;
  const reviewLabel = changeCount ? `Review the ${changeCount} change${changeCount === 1 ? "" : "s"}` : "Review the changes";
  const currentDestination = !switchNeeded && ((step.destination === "inbox" && currentView === "inbox") || (step.destination === "chat" && currentView === "chats") || (step.destination === "pricing" && currentView === "pricing") || (step.destination === "order" && currentView === "change-order" && currentOrderId === step.orderId));
  // A skip that belongs in the inbox opens it first, so the reminder is seen arriving.
  const skipHere = !!step.skipTo && (step.destination !== "inbox" || currentView === "inbox");
  const action = switchNeeded ? `Continue as ${nextName}` : skipping ? "Running each day's check…" : step.skipTo ? skipHere ? step.action : "Open your Inbox" : currentDestination ? step.destination === "pricing" ? step.anchor === "pricing-source-status" ? step.action : reviewLabel : step.destination === "order" ? step.anchor === "payments" ? "Go to payments below" : "Go to client review below" : step.action : step.action;
  const outcomes = data.payments && data.payments.orderId !== data.seedOrderId ? mapleChangeLines(data.payments) : [];

  function continueGuide() {
    if (skipping) return;
    if (step.skipTo && !switchNeeded && skipHere) { void skip(step.skipTo); return; }
    if (switchNeeded) onSwitchAccount(step.role);
    if (step.destination === "inbox") {
      if (currentView === "inbox") document.getElementById("inbox-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
      else if (onOpenInbox && !switchNeeded) onOpenInbox();
      else navigateGuidePage("/inbox", switchNeeded);
      return;
    }
    if (step.destination === "chat") {
      if (step.chatAction === "ask-payments") {
        try { window.location.assign(paymentQuestionHref(projectKey, crypto.randomUUID(), window.sessionStorage)); }
        catch { setError("The payment question could not open. In the chat, select Ask about payments, then Send."); }
        return;
      }
      if (step.anchor) {
        if (currentView === "chats" || currentView === "quotes") {
          onOpenChat();
          window.requestAnimationFrame(() => document.getElementById(step.anchor!)?.scrollIntoView({ behavior: "smooth", block: "center" }));
        } else window.location.assign(`/chats/${projectKey}#${step.anchor}`);
        return;
      }
      onOpenChat();
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project message"]')?.focus());
    } else if (currentDestination) {
      if (step.destination === "pricing") {
        const notice = step.anchor ? document.getElementById(step.anchor) : null;
        // The pricing page opens its first change to check in the details drawer.
        if (notice) notice.scrollIntoView({ behavior: "smooth", block: "center" });
        else window.dispatchEvent(new Event(OPEN_FIRST_CHANGE_EVENT));
      }
      else document.getElementById(step.anchor ?? "payments")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      navigateGuidePage(step.destination === "pricing" ? `/pricing/maple${step.anchor ? `#${step.anchor}` : ""}` : `/change-orders/${step.orderId}${step.anchor ? `#${step.anchor}` : ""}`, switchNeeded);
    }
  }

  async function copyRequest() {
    try { await navigator.clipboard.writeText(exampleRequest); setCopied(true); }
    catch { setCopied(false); setError("Copy is unavailable here. You can select the example text below and paste it into the chat."); }
  }

  const days = data.simulatedDays ?? 0;
  return <GuideBar label="Maple demo guide" steps={guideSteps} step={step} action={action} onAction={continueGuide} error={skipError ?? error} busy={skipping}
    tools={<>{days > 0 && <span className={GUIDE_TOOL} title="Simulated time: Setti judges holds as if this many days had passed. PayPal calls still happen now, in the Sandbox.">Simulated time · day {days}</span>}<button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailsId} className={GUIDE_TOOL}>{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{expanded ? "Hide details" : "Money and story"}</button></>}>
    <PaymentSetupNotice embedded />
    {step.secondary && !switchNeeded && <a href={step.secondary.href} className="mt-1.5 inline-flex text-[11px] font-medium text-brand-700 underline underline-offset-2">{step.secondary.label}</a>}
    <div id={detailsId} hidden={!expanded} className="mt-2.5 max-h-[28dvh] overflow-y-auto border-t border-[var(--primary-line)] pr-1 pt-2.5 text-left text-[11px] leading-relaxed text-slate-500">
    {outcomes.length > 0 && <div className="mb-3 grid gap-2 sm:grid-cols-3">
      {outcomes.map((line) => {
        const progress = lineProgress(line, data.payments!.operations);
        const href = `/change-orders/${data.payments!.orderId}#payment-line-${line.side}-${line.itemId}`;
        const result = line.side === "baseline" && line.change === "replace" ? `Released ${money(line.releasedCents)} · still held ${money(line.heldCents)}` : line.change === "remove" ? `Refunded ${money(line.refundedCents)} · retained target ${money(line.targetCents)}` : `Captured ${money(line.capturedCents)} · held ${money(line.heldCents)}`;
        // A plain link: on the same page, the hash change opens the item's side card.
        return <a href={href} key={`${line.side}:${line.itemId}`} className="min-w-0 rounded-lg border border-brand-100 bg-white px-3 py-2 hover:border-brand-300"><p className="truncate text-[11px] font-semibold text-slate-800">{line.label}{line.change === "replace" ? line.side === "baseline" ? " · old item" : " · replacement" : ""}</p><p className={`mt-1 text-[10px] font-medium ${progress.settled ? "text-emerald-700" : "text-amber-800"}`}>{progress.label}</p><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{result}</p></a>;
      })}
    </div>}
      <p>{home ? `Emma confirmed the living-and-dining V${startingVersion}. ${data.preparationPending ? "The starting test payments are being prepared in the background; use the progress notice to see which records are complete." : "The sofa, coffee table, dining table and six chairs have individual Sandbox holds and have not been ordered. The sideboard's $1,200 test payment has been captured."} The $1,000 design fee is unchanged and unpaid. The sample conversation ends before Jordan requests a revised quote.` : "Prepared starting point: Emma confirmed V2; the lounge chair has an $800 hold and the wool rug has a completed $300 payment. These starting transactions were created on PayPal Sandbox with a test card. They are history prepared for this demo, not actions you just took."}</p>
      <Link href={data.seedOrderId ? `/change-orders/${data.seedOrderId}#payments` : "/quotes/maple#item-holds"} className="mt-1 inline-block font-medium text-[var(--primary)] underline">Inspect the starting V{startingVersion} payment records</Link>
      <div className="mt-2 rounded-lg border border-brand-100 bg-white p-2.5"><p className="select-text text-[11px] text-slate-700">{exampleRequest}</p><button type="button" onClick={() => void copyRequest()} className="mt-2 inline-flex items-center gap-1 font-medium text-brand-700"><Copy className="h-3 w-3" />{copied ? "Copied · paste and send when ready" : home ? "Copy designer request" : "Copy example request"}</button></div>
      <p className="mt-2">{home ? `The initial V${startingVersion}, discussion and supplier documents are prepared fictional examples. A new @Setti request uses the configured model to select sources and draft changes; prices and totals come from the supplied evidence and the pricing engine.` : "The initial AI draft and prior demo decisions are scripted. Your new @Setti requests use the configured model; supplier confirmations and credits are designer-entered demo records."} You still review prices, sign the client version and confirm each money action yourself. No real money moves. The cards above cover this change, not the whole project&rsquo;s settlement.</p>
    </div>
  </GuideBar>;
}

/** Where the background test payments stand: a row of the guide, or its own bar before the guide has loaded. */
function PaymentSetupNotice({ embedded = false }: { embedded?: boolean }) {
  const { seed, error, refresh, retry } = useTryPreparation();
  if (!seed || seed.scenario !== HOME_SCENARIO || seed.status === "ready") return null;
  const stages = seed.stages.filter((stage) => stage.id !== "quote" && stage.id !== "discussion");
  const done = stages.filter((stage) => stage.status === "done").length;
  const paused = seed.status === "failed" || !!error;
  const body = <>
    <div className="flex flex-wrap items-center gap-2"><span role="status" className="flex flex-1 items-center gap-1.5 font-medium">{!paused && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[var(--primary)]" />}{paused ? "Test payment setup paused" : "Preparing the starting test payments in the background"}<span className="font-normal text-[var(--muted)]">· {done}/{stages.length} saved</span></span>{paused && <button type="button" disabled={seed.busy} onClick={() => seed.canResume ? retry() : void refresh()} className="font-semibold text-[var(--primary)] underline disabled:opacity-50">{seed.canResume ? "Resume setup" : "Check saved status"}</button>}</div>
    <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--muted)]">Keep reading the discussion and reviewing the quote. Sending the revised version and payment actions open when setup finishes.</p>
    {paused && <p className="mt-1 text-[10px] text-amber-800">{error || seed.error || "The saved records remain available. Resume the same setup when ready."}</p>}
    <details className="mt-1.5 text-[10px] text-[var(--muted)]"><summary className="w-fit cursor-pointer font-medium">See setup progress</summary><ol className="mt-1.5 space-y-1">{stages.map((stage) => <li key={stage.id} className="flex items-start gap-2">{stage.status === "done" ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-700" /> : <span className="w-3 shrink-0">·</span>}<span>{stage.label} · {stage.status === "done" ? "Saved" : stage.status === "running" ? "In progress" : stage.status === "failed" ? "Paused" : "Waiting"}</span></li>)}</ol></details>
  </>;
  return embedded
    ? <section aria-label="Background payment setup" className="mt-2.5 border-t border-[var(--primary-line)] pt-2.5 text-[11px]">{body}</section>
    : <aside aria-label="Background payment setup" className="shrink-0 rounded-xl border border-[var(--primary-line)] bg-[var(--primary-soft)] px-4 py-3 text-[11px] text-[var(--ink)]">{body}</aside>;
}
