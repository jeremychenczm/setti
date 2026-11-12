"use client";

import { ArrowLeft, ChevronRight, FileText, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { ApprovalWorkspace } from "@/approval/types";
import { quoteTitle } from "@/pricing/title";
import type { FrozenChangeOrder } from "@/pricing/types";
import { quoteDesignerName } from "@/projects/settings";
import { ProjectPayments } from "../payments/ProjectPayments";
import { ChangeSourceNote } from "./ChangeSource";
import { PaymentsPanel } from "../payments/PaymentsPanel";
import { ApprovalPanel, isApprovalWorkspace } from "./ApprovalPanel";
import { changeOrderStatusClass, changeOrderStatusLabel } from "./changeOrderStatus";
import { dateOnly, dateTime, money, safeUrl, signedMoney } from "./common";
import { FundingImpactPreview } from "./FundingImpactPreview";
import { QuoteLines } from "./QuoteLines";
import { TryPageGuide } from "../try/TryPageGuide";
import { DemoModeProvider } from "../demo-mode";

/** "From Jordan Lee · Nov 9, 2026 · 7 changes to the V1 confirmed on Oct 3, 2026". */
function metaLine(order: FrozenChangeOrder): string {
  const count = order.changes.length;
  // The confirmed version's date: its last line approval (a V1 is approved line by line).
  const confirmed = order.baselineLines.map((line) => line.approval?.approvedAt).filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return `From ${quoteDesignerName(order)} · ${dateOnly(order.issuedAt)} · ${count} ${count === 1 ? "change" : "changes"} to the V${order.basedOnVersion}${confirmed ? ` confirmed on ${dateOnly(confirmed)}` : ""}`;
}

/** One folded section at the foot of the page. */
function Fold({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <details className="group border-b border-[var(--line)] last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-md px-0.5 py-2.5 text-[13px] font-medium [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]"><ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-[var(--muted)] transition-transform group-open:rotate-90 motion-reduce:transition-none" />{title}{count !== undefined && <span className="font-normal text-[var(--muted)]">{count}</span>}</summary>
    <div className="mb-3 ml-6 text-[12px] leading-relaxed text-slate-600">{children}</div>
  </details>;
}

/** `account` is who the signed-in viewer is in the order's project; null for anyone else, who reads the shared link. */
export function ChangeOrderPage({ orderId, account, demo = false }: { orderId: string; account: DemoAccount | null; demo?: boolean }) {
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
  // The designer's confirmed version opens on its payment steps; the quote waits folded below.
  const workbench = designer && status === "approved" && view?.decision?.decision === "approved";
  const caption = !order ? "" : status === "awaiting_client_confirmation" ? `The new quote total if you confirm V${order.version}. It isn't one payment.`
    : status === "approved" ? `The confirmed V${order.version} quote total. It isn't one payment.` : `The V${order.version} quote total. It isn't a payment request.`;

  return <DemoModeProvider value={demo}><div className="min-h-dvh bg-[var(--canvas)] px-3 py-5 text-[var(--ink)] sm:px-6"><main className={`mx-auto ${workbench ? "max-w-[1120px]" : "max-w-[860px]"}`}>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-fill)] text-[var(--on-primary)]">S</span>Setti</div>{workspace?.clientName && order && <a href={`/chats/${order.projectKey}`} className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-900"><ArrowLeft className="h-3.5 w-3.5" />Back to project chat</a>}<button onClick={() => void load()} disabled={loading || approvalBusy} className="flex items-center gap-1.5 text-[11px] text-slate-500 hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Refresh status</button><span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-medium text-slate-500">{workspace?.clientName ? demo ? "Client review · demo session" : "Client review" : demo ? "Read-only shared review · demo" : "Read-only shared review"}</span></header>
    {loading && !order && <div role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the frozen client version…</div>}
    {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{error}</div>}
    {order && workspace && <>
      {/* The walkthrough guide stays in view while the page scrolls. */}
      {demo && account && <div className="sticky top-0 z-30 -mx-3 mb-5 bg-[var(--canvas)] px-3 pb-3 pt-3 sm:-mx-6 sm:px-6"><TryPageGuide projectKey={order.projectKey} account={account} currentView="change-order" currentOrderId={order.id} /></div>}

      {/* Money first: the version, its totals and what confirming does to the client's money. */}
      <section className="mb-5 grid gap-4 rounded-xl bg-white p-5 shadow-sm sm:p-6" aria-labelledby="change-order-title">
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
        {!workbench && <FundingImpactPreview order={order} plan={workspace.fundingPlan} status={status} canView={workspace.clientName !== null} />}
        {workspace.clientName && view?.decision && <a href={`/receipts/${order.projectKey}/${order.version}`} className="inline-flex items-center gap-1 justify-self-start text-[12px] font-medium text-[var(--primary)] hover:underline"><FileText className="h-3.5 w-3.5" />Signed version receipt</a>}
      </section>

      {workbench ? <>
        <PaymentsPanel key={`payments-${order.id}`} order={order} designer onChange={() => void load()} />
        <QuoteLines order={order} onChangeLine={changeLine} lineError={lineError} folded />
        <ApprovalPanel key={order.id} workspace={workspace} loading={loading} onChange={setWorkspace} onBusyChange={setApprovalBusy} />
      </> : <>
        <QuoteLines order={order} onChangeLine={designer && status === "approved" ? changeLine : undefined} lineError={lineError} />
        <ApprovalPanel key={order.id} workspace={workspace} loading={loading} onChange={setWorkspace} onBusyChange={setApprovalBusy} />
        {view?.decision?.decision === "approved" && <div className="mb-5"><ProjectPayments projectKey={order.projectKey} orderId={order.id} /></div>}
        {view?.decision?.decision === "approved" && <PaymentsPanel key={`payments-${order.id}`} order={order} onChange={() => void load()} />}
      </>}

      <section aria-label="More about this version" className="rounded-xl bg-white px-5 py-1.5 shadow-sm sm:px-6">
        {order.constraints.length > 0 && <Fold title="Terms to keep" count={order.constraints.length}><ul className="list-disc space-y-1 pl-4">{order.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></Fold>}
        {order.issues.length > 0 && <Fold title="Designer checks" count={order.issues.length}><ul className="space-y-2">{order.issues.map((issue) => <li key={issue.id} className="rounded-lg bg-slate-50 p-3"><p className="font-medium text-slate-800">{issue.label}</p><p className="mt-1 whitespace-pre-wrap">{issue.note || "No additional note."}</p></li>)}</ul></Fold>}
        <Fold title="Client terms and review notes"><h3 className="font-medium text-slate-800">Client terms</h3><p className="mt-1 whitespace-pre-wrap">{order.terms}</p><h3 className="mt-3 font-medium text-slate-800">Designer review notes</h3><p className="mt-1 whitespace-pre-wrap">{order.reviewNotes || "No additional notes."}</p></Fold>
        <Fold title="Discussion and sources"><div className="space-y-3">{order.sourceMessages.map((message) => <div key={message.id} className="rounded-lg bg-slate-50 p-3"><p className="mb-1 text-[10px] text-slate-400">{message.actor} · {dateTime(message.createdAt)} PT</p><p className="whitespace-pre-wrap break-words">{message.text}</p></div>)}{order.sources.map((source) => <div key={source.id} className="rounded-lg border border-slate-200 p-3"><p className="font-medium">{source.title || source.url}</p>{safeUrl(source.url) && <a href={safeUrl(source.url)!} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-[var(--primary)] underline">{source.url}</a>}<p className="mt-1 text-[10px] text-slate-400">Retrieved {dateTime(source.fetchedAt)} PT</p>{source.error && <p className="mt-1 text-amber-800">{source.error}</p>}{source.products.map((product) => <p key={product.id} className="mt-2 text-[11px] text-slate-600">{product.name} · {product.sku} · brand {product.brand ?? "unconfirmed"} · seller {product.seller ?? "unconfirmed"}<br />{product.specification}<br />{product.priceEvidence}</p>)}</div>)}</div></Fold>
        <Fold title="Record identifiers"><p className="mb-3 flex items-start gap-1.5 text-[11px]"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />{view?.decision ? "This snapshot remains frozen. The client decision is recorded separately for this exact version." : "This snapshot is frozen and awaits a client decision. No payment has been made through this change order."}</p><dl className="space-y-3 text-[11px]"><div><dt className="text-slate-400">Change order ID</dt><dd className="mt-1 select-all break-all font-mono">{order.id}</dd></div><div><dt className="text-slate-400">Frozen content hash</dt><dd className="mt-1 select-all break-all font-mono">{order.contentHash}</dd></div><div><dt className="text-slate-400">Quote revision ID</dt><dd className="mt-1 select-all break-all font-mono">{order.revisionId}</dd></div><div><dt className="text-slate-400">Quote revision content hash</dt><dd className="mt-1 select-all break-all font-mono">{order.revisionContentHash}</dd></div></dl></Fold>
      </section>
    </>}
  </main></div></DemoModeProvider>;
}
