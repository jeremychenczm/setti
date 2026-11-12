"use client";

import { ChevronRight, FileText, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { ApprovalWorkspace } from "@/approval/types";
import { quoteTitle } from "@/pricing/title";
import type { FrozenChangeOrder } from "@/pricing/types";
import { quoteDesignerName } from "@/projects/settings";
import { BackToChat } from "../BackToChat";
import { ProjectPayments } from "../payments/ProjectPayments";
import { PreviewQuoteLink } from "../receipts/PreviewQuoteLink";
import { ReceiptDocument } from "../receipts/ReceiptDocument";
import { EditorCrumbs } from "./EditorFrame";
import { ViewProjectInfo } from "../quotes/ViewProjectInfo";
import { useVersionReceipt } from "../receipts/useVersionReceipt";
import { ChangeSourceNote } from "./ChangeSource";
import { PaymentsPanel } from "../payments/PaymentsPanel";
import { ApprovalPanel, isApprovalWorkspace } from "./ApprovalPanel";
import { changeOrderStatusClass, changeOrderStatusLabel } from "./changeOrderStatus";
import { dateOnly, dateTime, money, safeUrl, signedMoney } from "./common";
import { FundingImpactPreview } from "./FundingImpactPreview";
import { MoneyCard } from "./MoneyCard";
import { QuoteLines } from "./QuoteLines";
import { VersionChanges } from "./VersionChanges";
import { TryPageGuide } from "../try/TryPageGuide";
import { DemoModeProvider } from "../demo-mode";
import { BrandMark } from "../BrandMark";

/** "From Jordan Lee · Nov 9, 2026 · 7 changes to the V1 confirmed on Oct 3, 2026". */
function metaLine(order: FrozenChangeOrder): string {
  const count = order.changes.length;
  // The confirmed version's date: its last line approval (a V1 is approved line by line).
  const confirmed = order.baselineLines.map((line) => line.approval?.approvedAt).filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return `From ${quoteDesignerName(order)} · ${dateOnly(order.issuedAt)} · ${count} ${count === 1 ? "change" : "changes"} to the V${order.basedOnVersion}${confirmed ? ` confirmed on ${dateOnly(confirmed)}` : ""}`;
}

/** An element's height as it changes: a callback ref and the last height seen. */
function useHeight(): [(element: HTMLElement | null) => (() => void) | undefined, number] {
  const [height, setHeight] = useState(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

/** One folded section at the foot of the page. */
function Fold({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <details className="group border-b border-[var(--line)] last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-md px-0.5 py-2.5 text-[13px] font-medium [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]"><ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-[var(--muted)] transition-transform group-open:rotate-90 motion-reduce:transition-none" />{title}{count !== undefined && <span className="font-normal text-[var(--muted)]">{count}</span>}</summary>
    <div className="mb-3 ml-6 text-[12px] leading-relaxed text-slate-600">{children}</div>
  </details>;
}

/** `account` is who the signed-in viewer is in the order's project; null for anyone else, who reads the shared link. */
/** One sent version. `embedded` inside the Quotes module, whose sidebar and walkthrough guide stand in for the page header and guide. */
export function ChangeOrderPage({ orderId, account, demo = false, studioName = "", embedded = false, toolbar }: { orderId: string; account: DemoAccount | null; demo?: boolean; studioName?: string; embedded?: boolean; toolbar?: ReactNode }) {
  const designer = account?.role === "designer";
  const [workspace, setWorkspace] = useState<ApprovalWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/change-orders/${encodeURIComponent(orderId)}/approval`, { cache: "no-store", signal });
      const body = await response.json().catch(() => null);
      if (!response.ok || !isApprovalWorkspace(body, orderId)) throw new Error(body?.error ?? "This change order could not be found.");
      if (!signal?.aborted) setWorkspace(body);
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load the client version."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [orderId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  const view = workspace?.view;
  const order = view?.order;
  const status = view?.status ?? "awaiting_client_confirmation";
  const [lineError, setLineError] = useState<string | null>(null);
  /** The designer starts a new version from a line of this confirmed version. */
  async function changeLine(itemId: string) {
    setLineError(null);
    const response = await fetch(`/api/pricing/${order!.projectKey}/change-line`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId }) });
    const body = await response.json().catch(() => null) as { href?: string; error?: string } | null;
    if (!response.ok || !body?.href) { setLineError(body?.error ?? "The line could not be changed. Please retry."); return; }
    window.location.assign(body.href);
  }
  // The project's people open the version's formal document; a shared link does not.
  const member = !!workspace?.clientName;
  // The designer's confirmed version opens on its payment steps; the quote waits folded below.
  const workbench = designer && status === "approved" && view?.decision?.decision === "approved";
  // Until it is confirmed, the version reads beside its formal quote. A client who confirms it here keeps
  // this layout, so the decision card stays mounted while it hands over to the chat.
  const [confirmedHere, setConfirmedHere] = useState(false);
  const decided = (next: ApprovalWorkspace) => {
    setConfirmedHere((already) => already || (!view?.decision && next.view.decision?.decision === "approved"));
    setWorkspace(next);
  };
  // The client always reads the version beside its formal quote; the studio's confirmed version opens on its payments.
  const split = !!order && member && (!designer || status !== "approved" || confirmedHere);
  const formal = useVersionReceipt(order?.projectKey ?? "", order?.version ?? 0, { enabled: split, refresh: `${status}:${view?.decision?.id ?? ""}` });
  // The studio reads about the client by name; the client reads "you".
  const clientFirstName = designer && workspace?.clientName ? workspace.clientName.split(" ")[0] : undefined;
  const confirms = clientFirstName ? `${clientFirstName} confirms` : "you confirm";
  const caption = !order ? "" : status === "awaiting_client_confirmation" ? `The new quote total if ${confirms} V${order.version}. It isn't one payment.`
    : status === "approved" ? `The confirmed V${order.version} quote total. It isn't one payment.` : `The V${order.version} quote total. It isn't a payment request.`;
  // The right column stays in view below the walkthrough guide, which is sticky too. Taller than the
  // window, it scrolls with the page until its foot is in view, then stays: nothing scrolls inside it.
  const [guide, guideHeight] = useHeight();
  const [column, columnHeight] = useHeight();
  const [windowHeight, setWindowHeight] = useState(0);
  useEffect(() => {
    const fit = () => setWindowHeight(window.innerHeight);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const below = (demo && account && !embedded ? guideHeight : 0) + 16;
  const stickyTop = windowHeight && below + columnHeight + 16 > windowHeight ? windowHeight - columnHeight - 16 : below;

  const summary = order && workspace && <section className={`grid gap-4 rounded-xl bg-white p-5 shadow-sm sm:p-6 ${split ? "" : "mb-5"}`} aria-labelledby="change-order-title">
    <div className="grid justify-items-start gap-1">
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${changeOrderStatusClass(status)}`}>{changeOrderStatusLabel(status)}</span>
      <h1 id="change-order-title" className="mt-1.5 text-[22px] font-semibold tracking-tight">{quoteTitle(order)}</h1>
      <p className="text-[12px] text-[var(--muted)]">{metaLine(order)}</p>
    </div>
    {order.source?.kind === "vendor" && <ChangeSourceNote source={order.source} detailed />}
    {status === "superseded" && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">A newer client version has been issued. This older link remains an unchanged historical record. Ask the designer for the latest version before confirming the scope.</div>}
    <div className="grid gap-1.5">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
        <span className="text-[15px] text-[var(--muted)]"><span className="sr-only">V{order.basedOnVersion} total </span>{money(order.baselineTotals.totalCents)}</span>
        <span aria-hidden className="text-[var(--muted)]">→</span>
        <span className="text-[22px] font-semibold tracking-tight"><span className="sr-only">V{order.version} total </span>{money(order.totals.totalCents)}</span>
        <span className="rounded-full border border-[var(--primary-line)] bg-brand-50 px-2.5 py-px text-[13px] font-semibold text-[var(--primary)]"><span className="sr-only">Difference </span>{signedMoney(order.deltaTotalCents)}</span>
      </p>
      <p className="text-[12px] text-[var(--muted)]">{caption}</p>
    </div>
    {/* Beside the formal quote, the client reads the money in its own card. */}
    {!workbench && (designer || !split) && <FundingImpactPreview order={order} plan={workspace.fundingPlan} status={status} canView={member} client={clientFirstName} />}
    {member && view?.decision && <a href={`/receipts/${order.projectKey}/${order.version}`} className="inline-flex items-center gap-1 justify-self-start text-[12px] font-medium text-[var(--primary)] hover:underline"><FileText className="h-3.5 w-3.5" />Signed version receipt</a>}
  </section>;
  const viewHead = <>
    <EditorCrumbs section={designer ? "Quotes" : "Proposals"} name={order?.projectName ?? ""} right={toolbar} />
    {order && member && <ViewProjectInfo projectKey={order.projectKey} client={!designer} studioName={studioName} designerName={order.designerName} clientName={workspace?.clientName ?? order.clientName} projectName={order.projectName} version={order.version} />}
  </>;
  const approval = workspace && order && <ApprovalPanel key={order.id} workspace={workspace} loading={loading} onChange={decided} onBusyChange={setApprovalBusy} />;

  return <DemoModeProvider value={demo}><div className={embedded ? "min-w-0 pb-2 text-[var(--ink)]" : "min-h-dvh bg-[var(--canvas)] px-3 py-5 text-[var(--ink)] sm:px-6"}><main className={`${embedded ? "" : "mx-auto"} ${embedded ? "" : split ? "max-w-[1280px]" : workbench ? "max-w-[1120px]" : "max-w-[860px]"}`}>
    {/* The studio's confirmed version puts these at the top of its working column, beside the money. */}
    {embedded && !workbench && <div className="mb-3 grid gap-3">{viewHead}</div>}
    {!embedded && <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      {!embedded && <div className="flex items-center gap-2 text-sm font-semibold"><BrandMark className="h-7 w-7" />Setti</div>}
      {member && order && !embedded && <BackToChat projectKey={order.projectKey} />}
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <button onClick={() => void load()} disabled={loading || approvalBusy} className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Refresh status</button>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-medium text-slate-500">{workspace?.clientName ? demo ? "Client review · demo session" : "Client review" : demo ? "Read-only shared review · demo" : "Read-only shared review"}</span>
        {member && order && <PreviewQuoteLink projectKey={order.projectKey} version={order.version} />}
      </div>
    </header>}
    {loading && !order && <div role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the frozen client version…</div>}
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{error}</div>}
    {order && workspace && <>
      {/* The walkthrough guide stays in view while the page scrolls. */}
      {demo && account && !embedded && <div ref={guide} className="sticky top-0 z-30 -mx-3 mb-5 bg-[var(--canvas)] px-3 pb-3 pt-3 sm:-mx-6 sm:px-6"><TryPageGuide projectKey={order.projectKey} account={account} currentView="change-order" currentOrderId={order.id} /></div>}

      {split ? <>
        {/* From 1024px: the formal quote on the left, the money and the decision beside it. Narrower, the right column comes first. */}
        <div className="mb-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]" style={{ "--sticky-top": `${stickyTop}px` } as CSSProperties}>
          <div ref={column} className="grid min-w-0 gap-4 lg:sticky lg:top-[var(--sticky-top)] lg:col-start-2 lg:row-start-1">
            {summary}
            {!designer && <MoneyCard order={order} plan={workspace.fundingPlan} status={status} canView={member} />}
            {(!designer || view?.decision) && approval}
            {formal && "receipt" in formal && <VersionChanges receipt={formal.receipt} />}
          </div>
          <div className="min-w-0 rounded-xl bg-[#8e8c85] p-3 sm:p-[18px] lg:col-start-1 lg:row-start-1">
            {!formal && <p role="status" className="flex items-center gap-2 rounded-lg bg-white/90 p-6 text-[13px] text-slate-600"><LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />Loading the formal quote…</p>}
            {formal && "error" in formal && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{formal.error}</p>}
            {formal && "receipt" in formal && <ReceiptDocument receipt={formal.receipt} studioName={studioName} embedded updating={formal.stale} />}
          </div>
        </div>
        {!designer && view?.decision?.decision === "approved" && <>
          <div className="mb-5"><ProjectPayments projectKey={order.projectKey} orderId={order.id} /></div>
          <PaymentsPanel key={`payments-${order.id}`} order={order} onChange={() => void load()} />
        </>}
      </> : <>
        {!workbench && summary}
        {/* The studio's confirmed version is its orders and payments; the signed quote opens from the version list or the card's button. */}
        {workbench ? <PaymentsPanel key={`payments-${order.id}`} order={order} designer head={embedded ? viewHead : undefined} onChange={() => void load()} /> : <>
          <QuoteLines order={order} onChangeLine={designer && status === "approved" ? changeLine : undefined} lineError={lineError} />
          {approval}
          {view?.decision?.decision === "approved" && <div className="mb-5"><ProjectPayments projectKey={order.projectKey} orderId={order.id} /></div>}
          {view?.decision?.decision === "approved" && <PaymentsPanel key={`payments-${order.id}`} order={order} onChange={() => void load()} />}
        </>}
      </>}

      {/* Beside the formal quote these would only repeat it; without one they are the version's record. */}
      {!split && !workbench && <section aria-label="More about this version" className="rounded-xl bg-white px-5 py-1.5 shadow-sm sm:px-6">
        {order.constraints.length > 0 && <Fold title="Terms to keep" count={order.constraints.length}><ul className="list-disc space-y-1 pl-4">{order.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></Fold>}
        {order.issues.length > 0 && <Fold title="Designer checks" count={order.issues.length}><ul className="space-y-2">{order.issues.map((issue) => <li key={issue.id} className="rounded-lg bg-slate-50 p-3"><p className="font-medium text-slate-800">{issue.label}</p><p className="mt-1 whitespace-pre-wrap">{issue.note || "No additional note."}</p></li>)}</ul></Fold>}
        <Fold title="Client terms and review notes"><h3 className="font-medium text-slate-800">Client terms</h3><p className="mt-1 whitespace-pre-wrap">{order.terms}</p><h3 className="mt-3 font-medium text-slate-800">Designer review notes</h3><p className="mt-1 whitespace-pre-wrap">{order.reviewNotes || "No additional notes."}</p></Fold>
        <Fold title="Discussion and sources"><div className="space-y-3">{order.sourceMessages.map((message) => <div key={message.id} className="rounded-lg bg-slate-50 p-3"><p className="mb-1 text-[10px] text-slate-400">{message.actor} · {dateTime(message.createdAt)} PT</p><p className="whitespace-pre-wrap break-words">{message.text}</p></div>)}{order.sources.map((source) => <div key={source.id} className="rounded-lg border border-slate-200 p-3"><p className="font-medium">{source.title || source.url}</p>{safeUrl(source.url) && <a href={safeUrl(source.url)!} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-[var(--primary)] underline">{source.url}</a>}<p className="mt-1 text-[10px] text-slate-400">Retrieved {dateTime(source.fetchedAt)} PT</p>{source.error && <p className="mt-1 text-amber-800">{source.error}</p>}{source.products.map((product) => <p key={product.id} className="mt-2 text-[11px] text-slate-600">{product.name} · {product.sku} · brand {product.brand ?? "unconfirmed"} · seller {product.seller ?? "unconfirmed"}<br />{product.specification}<br />{product.priceEvidence}</p>)}</div>)}</div></Fold>
        <Fold title="Record identifiers"><p className="mb-3 flex items-start gap-1.5 text-[11px]"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />{view?.decision ? "This snapshot remains frozen. The client decision is recorded separately for this exact version." : "This snapshot is frozen and awaits a client decision. No payment has been made through this change order."}</p><dl className="space-y-3 text-[11px]"><div><dt className="text-slate-400">Change order ID</dt><dd className="mt-1 select-all break-all font-mono">{order.id}</dd></div><div><dt className="text-slate-400">Frozen content hash</dt><dd className="mt-1 select-all break-all font-mono">{order.contentHash}</dd></div><div><dt className="text-slate-400">Quote revision ID</dt><dd className="mt-1 select-all break-all font-mono">{order.revisionId}</dd></div><div><dt className="text-slate-400">Quote revision content hash</dt><dd className="mt-1 select-all break-all font-mono">{order.revisionContentHash}</dd></div></dl></Fold>
      </section>}
    </>}
  </main></div></DemoModeProvider>;
}
