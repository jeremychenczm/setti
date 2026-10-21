"use client";

import { ArrowUpRight, CircleDollarSign, LoaderCircle, LockKeyhole, ReceiptText, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FrozenChangeOrder } from "@/pricing/types";
import type { OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace } from "@/payments/types";
import { dateTime, money } from "../pricing/common";

type Action = { action: "authorize"; itemId: string; side: PaymentLineView["side"] } | { action: "check" | "cancel"; operationId: string };

const kindLabels: Record<OperationView["kind"], string> = { authorize: "Authorization", capture: "Capture", void: "Release hold (void)", refund: "Refund", reauthorize: "Reauthorization" };
const statusLabels: Record<OperationView["status"], string> = { pending: "In progress", succeeded: "PayPal confirmed", failed: "Not done", unknown: "Outcome unknown · check PayPal" };
const returnNotices: Record<string, { tone: "ok" | "warn"; text: string }> = {
  authorized: { tone: "ok", text: "PayPal confirmed the authorization. The amount is held, not charged." },
  awaiting_buyer: { tone: "warn", text: "PayPal has not reported an approval for this checkout yet. Continue to PayPal or check its status again." },
  cancelled: { tone: "warn", text: "You left PayPal without approving. Nothing was authorized." },
  failed: { tone: "warn", text: "PayPal did not authorize this checkout. Nothing is held." },
  unknown: { tone: "warn", text: "Setti could not confirm the outcome with PayPal yet. Use “Check PayPal status”; nothing is shown as done until PayPal confirms it." },
  unmatched: { tone: "warn", text: "This return did not match the open checkout, so it was ignored. Check PayPal status from the payment step below." },
};

function isWorkspace(value: unknown, orderId: string): value is PaymentsWorkspace {
  return !!value && typeof value === "object" && (value as PaymentsWorkspace).orderId === orderId && Array.isArray((value as PaymentsWorkspace).lines);
}

async function call(orderId: string, body?: Action & { contentHash?: string; revisionContentHash?: string }): Promise<{ workspace: PaymentsWorkspace; redirectUrl: string | null }> {
  const response = await fetch(`/api/change-orders/${encodeURIComponent(orderId)}/payments`, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  const result = body ? json as { workspace: PaymentsWorkspace; redirectUrl: string | null } : { workspace: json as PaymentsWorkspace, redirectUrl: null };
  if (!isWorkspace(result.workspace, orderId)) throw new Error("The server returned incomplete payment records.");
  return result;
}

function lineState(line: PaymentLineView): string {
  if (line.refundedCents > 0) return line.capturedCents - line.refundedCents > 0 ? `Captured, then ${money(line.refundedCents)} refunded; ${money(line.capturedCents - line.refundedCents)} kept.` : "Captured, then fully refunded.";
  if (line.capturedCents > 0) return line.capturedCents >= line.targetCents ? "Paid: captured in full." : `Partly captured: ${money(line.capturedCents)} of ${money(line.targetCents)}.`;
  if (line.heldCents > 0) return `Authorized: ${money(line.heldCents)} is held on the client's PayPal. Nothing has been charged.`;
  if (line.releasedCents > 0) return "The hold was released (voided). Nothing was charged or refunded.";
  return line.targetCents > 0 ? "Not authorized yet. No money has moved for this line." : "Nothing to pay for this line under this version.";
}

export function PaymentsPanel({ order, onChange }: { order: FrozenChangeOrder; onChange?: () => void }) {
  const [workspace, setWorkspace] = useState<PaymentsWorkspace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const mutating = useRef(false);

  const load = useCallback(async () => {
    try { setWorkspace((await call(order.id)).workspace); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Payment records could not be loaded."); }
  }, [order.id]);

  useEffect(() => {
    void load();
    const returned = new URLSearchParams(window.location.search).get("paypal");
    if (returned && returnNotices[returned]) setNotice(returnNotices[returned]);
  }, [load]);

  async function run(action: Action, key: string) {
    if (mutating.current) return;
    mutating.current = true; setBusy(key); setError(null);
    try {
      const result = await call(order.id, { ...action, ...(action.action === "authorize" ? { contentHash: order.contentHash, revisionContentHash: order.revisionContentHash } : {}) });
      setWorkspace(result.workspace);
      onChange?.();
      if (result.redirectUrl) { setBusy("redirect"); window.location.assign(result.redirectUrl); return; }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment step could not be started.");
      await load();
    } finally {
      mutating.current = false;
      setBusy((current) => current === "redirect" ? current : null);
    }
  }

  if (!workspace) return <section id="payments" className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="flex items-center gap-2 text-[12px] text-slate-500">{error ?? <><LoaderCircle className="h-4 w-4 animate-spin" />Loading payment records…</>}</p></section>;
  const open = workspace.operations.filter((operation) => operation.status === "pending" || operation.status === "unknown");
  const plan = workspace.plan;
  const disabled = Boolean(busy);

  return <section id="payments" aria-labelledby="payments-title" className="mb-5 scroll-mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-center gap-2"><h2 id="payments-title" className="mr-auto flex items-center gap-2 text-[16px] font-semibold"><CircleDollarSign className="h-4.5 w-4.5 text-[var(--primary)]" />Payments · V{workspace.version}</h2><span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">PayPal Sandbox · test money</span><button onClick={() => void load()} disabled={disabled} className="flex items-center gap-1 text-[11px] text-slate-500 hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Reload</button></div>
    <p className="mt-2 text-[12px] leading-relaxed text-slate-600">Every amount below is read from recorded PayPal receipts for this exact confirmed version. A step runs only when you start it, and a result counts only after PayPal confirms it.</p>
    {notice && <div role="status" className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-[12px] leading-relaxed ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}><span className="flex-1">{notice.text}</span><button aria-label="Dismiss" onClick={() => setNotice(null)}><X className="h-3.5 w-3.5" /></button></div>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900">{error}</p>}
    {workspace.reason && <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />{workspace.reason}</p>}

    {open.length > 0 && <div className="mt-4 space-y-3">{open.map((operation) => <div key={operation.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-[12px] leading-relaxed text-amber-950">
      <p className="font-semibold">{kindLabels[operation.kind]} · {money(operation.amountCents)} · {operation.itemLabel ?? "item"}{operation.version ? ` · V${operation.version}` : ""}</p>
      <p className="mt-1">{operation.status === "unknown" ? "PayPal may or may not have completed this step. Check its status; Setti will not start a replacement." : operation.paypalOrderId ? operation.failureCode === "AUTHORIZATION_PENDING" ? "PayPal is reviewing this authorization. Nothing is held until PayPal creates it." : "Waiting for the client to approve on PayPal." : "Preparing the PayPal checkout."}{operation.failureMessage ? ` ${operation.failureMessage}` : ""}</p>
      {workspace.canAct || operation.approvalUrl ? <div className="mt-3 flex flex-wrap gap-3">
        {operation.approvalUrl && <a href={operation.approvalUrl} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[12px] font-semibold text-white hover:bg-blue-600">Continue to PayPal<ArrowUpRight className="h-3.5 w-3.5" /></a>}
        <button onClick={() => void run({ action: "check", operationId: operation.id }, `check:${operation.id}`)} disabled={disabled} className="inline-flex items-center gap-1.5 font-semibold underline disabled:opacity-50">{busy === `check:${operation.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check PayPal status</button>
        {operation.kind === "authorize" && <button onClick={() => void run({ action: "cancel", operationId: operation.id }, `cancel:${operation.id}`)} disabled={disabled} className="font-medium underline disabled:opacity-50">Cancel this checkout</button>}
      </div> : null}
    </div>)}</div>}

    {workspace.lines.length > 0 && <div className="mt-4 space-y-4">{workspace.lines.map((line) => <LineCard key={`${line.side}:${line.itemId}`} line={line} version={workspace.version} busy={busy} disabled={disabled} canAct={workspace.canAct} onStep={(step) => step.kind === "authorize" ? void run({ action: "authorize", itemId: line.itemId, side: line.side }, `authorize:${line.side}:${line.itemId}`) : undefined} />)}</div>}

    {plan && <>
      {workspace.others.lineCount > 0 && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">{workspace.others.lineCount} other quote lines ({money(workspace.others.targetCents)}) are outside this change. Setti shows their amounts but runs no payment step for them in this demo; they are not authorized or paid.</p>}
      {plan.status === "blocked" && plan.blockers.length > 0 && <div className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900"><p className="font-semibold">New payment steps wait until these are resolved</p><ul className="mt-2 list-disc space-y-1 pl-4">{plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
      <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-[12px] font-medium">Whole-quote funding preview · every line</summary>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">If every line of V{plan.version} were funded through Setti. Funding facts checked {dateTime(plan.factsAsOf)} PT.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[{ label: "New authorization", amount: plan.money.newAuthorizationCents }, { label: "Release authorization", amount: plan.money.releaseCents }, { label: "Planned capture / charge", amount: plan.money.chargeCents }, { label: "Planned refund", amount: plan.money.refundCents }].map((tile) => <div key={tile.label} className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">{tile.label}</p><p className="mt-1 text-[16px] font-semibold tabular-nums">{tile.amount === null ? "Unavailable" : money(tile.amount)}</p></div>)}</div>
        {plan.notices.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-slate-500">{plan.notices.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      </details>
    </>}

    {workspace.operations.length > 0 && <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="flex cursor-pointer items-center gap-2 text-[12px] font-medium"><ReceiptText className="h-3.5 w-3.5" />PayPal Sandbox evidence · {workspace.operations.length} payment step{workspace.operations.length === 1 ? "" : "s"}</summary><div className="mt-3 space-y-4">{workspace.operations.map((operation) => <div key={operation.id} className="rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed">
      <p className="font-semibold">{kindLabels[operation.kind]} · {money(operation.amountCents)} · {statusLabels[operation.status]}{operation.version ? ` · started for V${operation.version}` : ""}</p>
      <p className="mt-1 break-all font-mono text-[10px] text-slate-500">request {operation.requestId}{operation.paypalOrderId ? ` · order ${operation.paypalOrderId}` : ""}{operation.paypalResourceId ? ` · PayPal ${operation.paypalResourceId}` : ""}</p>
      {operation.failureCode && <p className="mt-1 text-slate-600">{operation.failureCode}{operation.failureMessage ? `: ${operation.failureMessage}` : ""}</p>}
      <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[560px] border-collapse text-left"><thead><tr className="text-slate-400"><th className="py-1 pr-2 font-medium">Call</th><th className="py-1 pr-2 font-medium">Result</th><th className="py-1 pr-2 font-medium">PayPal resource · status</th><th className="py-1 pr-2 font-medium">Amount</th><th className="py-1 font-medium">Debug id · time</th></tr></thead><tbody>{operation.calls.map((entry, index) => <tr key={index} className="border-t border-slate-200 align-top"><td className="py-1 pr-2 font-mono">{entry.step}</td><td className="py-1 pr-2">{entry.outcome}{entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : ""}{entry.errorCode ? ` · ${entry.errorCode}` : ""}</td><td className="py-1 pr-2 break-all font-mono">{entry.resourceId ?? "—"}{entry.resourceStatus ? ` · ${entry.resourceStatus}` : ""}</td><td className="py-1 pr-2 tabular-nums">{entry.amountCents === null ? "—" : money(entry.amountCents)}</td><td className="py-1 font-mono text-slate-500">{entry.debugId ?? "—"} · {dateTime(entry.createdAt)}</td></tr>)}</tbody></table></div>
    </div>)}</div></details>}
  </section>;
}

function LineCard({ line, version, busy, disabled, canAct, onStep }: { line: PaymentLineView; version: number; busy: string | null; disabled: boolean; canAct: boolean; onStep: (step: PaymentStep) => void }) {
  const tiles = [
    { label: `Confirmed in V${version}`, amount: line.targetCents },
    { label: "Authorized (held)", amount: line.heldCents },
    { label: "Captured", amount: line.capturedCents },
    { label: "Refunded", amount: line.refundedCents },
    { label: "Released hold", amount: line.releasedCents },
  ];
  return <article className="rounded-xl border border-slate-200 p-4">
    <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto text-[14px] font-semibold">{line.label}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{roleLabel(line)}</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{tiles.map((tile) => <div key={tile.label} className="rounded-lg bg-slate-50 p-2.5"><p className="text-[10px] text-slate-500">{tile.label}</p><p className="mt-0.5 text-[15px] font-semibold tabular-nums">{money(tile.amount)}</p></div>)}</div>
    <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-slate-700"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{lineState(line)}</p>
    {line.steps.length > 0 && <div className="mt-3 space-y-2">{line.steps.map((step, index) => <div key={index} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 p-3">
      {step.available && step.kind === "authorize"
        ? <button onClick={() => onStep(step)} disabled={disabled} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-blue-600 disabled:bg-slate-200 disabled:text-slate-400">{busy === `authorize:${line.side}:${line.itemId}` || busy === "redirect" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}Authorize {money(step.amountCents)} with PayPal</button>
        : <span className="rounded-lg bg-slate-100 px-3 py-2 text-[12px] font-medium text-slate-500">{stepLabel(step)}</span>}
      <p className="min-w-[200px] flex-1 text-[11px] leading-relaxed text-slate-500"><strong className="font-medium text-slate-600">{step.actor === "client" ? "Client step" : "Designer step"}.</strong> {step.note}{!canAct && step.kind === "authorize" ? " Open this version from the owning demo session to act as its client." : ""}</p>
    </div>)}</div>}
    {line.holds.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[620px] border-collapse text-left text-[11px]"><thead><tr className="text-slate-400"><th className="py-1 pr-2 font-medium">PayPal authorization · order</th><th className="py-1 pr-2 font-medium">Amount</th><th className="py-1 pr-2 font-medium">Status</th><th className="py-1 pr-2 font-medium">Created for</th><th className="py-1 font-medium">Honor period · expires</th></tr></thead><tbody>{line.holds.map((hold) => <tr key={hold.id} className="border-t border-slate-100 align-top"><td className="py-1.5 pr-2 font-mono">{hold.paypalAuthorizationId}<br /><span className="text-slate-400">{hold.paypalOrderId}</span></td><td className="py-1.5 pr-2 tabular-nums">{money(hold.amountCents)}{hold.capturedCents ? <><br /><span className="text-slate-500">captured {money(hold.capturedCents)}</span></> : null}</td><td className="py-1.5 pr-2">{hold.status}{hold.heldCents ? ` · ${money(hold.heldCents)} held` : ""}{hold.releasedCents ? ` · ${money(hold.releasedCents)} released` : ""}</td><td className="py-1.5 pr-2">{hold.version ? `V${hold.version}` : "—"}</td><td className="py-1.5">{hold.honorExpiresAt ? dateTime(hold.honorExpiresAt) : "—"}<br /><span className="text-slate-400">{hold.expiresAt ? dateTime(hold.expiresAt) : "not reported"}</span></td></tr>)}</tbody></table></div>}
  </article>;
}

function roleLabel(line: PaymentLineView): string {
  if (line.change === "replace") return line.side === "proposed" ? "Replacement product" : "Old product · replaced";
  return line.change === "quantity" ? "Quantity changed" : line.change === "remove" ? "Removed line" : line.change === "add" ? "Added line" : "Carried over";
}

function stepLabel(step: PaymentStep): string {
  const amount = money(step.amountCents);
  return { authorize: `Authorize ${amount}`, supplier_confirmation: "Supplier confirmation", capture: `Capture ${amount}`, void: `Release ${amount}`, supplier_credit: "Supplier credit", refund: `Refund ${amount}` }[step.kind];
}
