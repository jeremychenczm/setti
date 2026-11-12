"use client";

import { ArrowUpRight, Ban, ChevronRight, CircleDollarSign, LoaderCircle, LockKeyhole, ReceiptText, RefreshCw, ShieldCheck, Truck, X } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { nonRefundableText } from "@/pricing/fees";
import type { FrozenChangeOrder } from "@/pricing/types";
import type { SavedMethodView } from "@/payments/saved-methods";
import type { CheckoutView, OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace } from "@/payments/types";
import { centsText, dateTime, Field, inputClass, money, parseDollars } from "../pricing/common";
import { emptyPaymentFeedback, feedbackMessage, paymentFeedback, paymentReturnNotice } from "./feedback";
import { lineProgress, paymentScopeTotals } from "./progress";
import { demoSupplierNumber } from "./demo-supplier";
import { useDemoMode } from "../demo-mode";
import { PaymentFees } from "./PaymentFees";
import { PayMethodChooser, SavedMethodCard, savedMethodName } from "./PaymentMethods";
import { PayPalButtons } from "./PayPalButtons";
import { useTryReadiness } from "../try/useTryReadiness";
import type { CancellationReason } from "@/payments/cancellation";
import { CancellationRecord, CancelItemForm } from "./CancelItemForm";
import { paymentChanged, usePaymentRefresh } from "./usePaymentRefresh";
import { lineKey, nextBatchStep, PaymentWorkbench, type BatchMode, type BatchResult } from "./PaymentWorkbench";

type LineRef = { itemId: string; side: PaymentLineView["side"] };
type Action =
  | ({ action: "authorize"; via?: "popup" | "redirect" | "test_card" | "saved"; save?: boolean } & LineRef)
  | ({ action: "capture" | "release" | "refund" } & LineRef)
  | ({ action: "supplier_order"; quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean; leadTimeDays: number | null; reference: string; note: string } & LineRef)
  | ({ action: "supplier_credit"; creditCents: number; reference: string; note: string } & LineRef)
  | { action: "check" | "cancel"; operationId: string }
  | { action: "fees" | "hold_saved" | "remove_saved" };
type Reply = { workspace: PaymentsWorkspace; redirectUrl: string | null; operationId: string | null; paypalOrderId: string | null };

const kindLabels: Record<OperationView["kind"], string> = { authorize: "Authorization", capture: "Capture", void: "Release hold (void)", refund: "Refund", reauthorize: "Reauthorization" };
const statusLabels: Record<OperationView["status"], string> = { pending: "In progress", succeeded: "PayPal confirmed", failed: "Not done", unknown: "Outcome unknown · check PayPal" };
/** What a money step does, shown before the designer confirms it. */
const confirmations: Partial<Record<PaymentStep["kind"], { button: string; text: (amount: string) => string }>> = {
  capture: { button: "Confirm capture", text: (amount) => `Capture ${amount} now? PayPal takes the held money; each hold is captured separately and closed.` },
  void: { button: "Confirm release", text: (amount) => `Release ${amount} now? PayPal voids the remaining hold; nothing is charged or refunded.` },
  refund: { button: "Confirm refund", text: (amount) => `Refund ${amount} now? PayPal returns it from the completed captures, newest first.` },
};
const lineActions: Partial<Record<PaymentStep["kind"], "capture" | "release" | "refund">> = { capture: "capture", void: "release", refund: "refund" };

function isWorkspace(value: unknown, orderId: string): value is PaymentsWorkspace {
  return !!value && typeof value === "object" && (value as PaymentsWorkspace).orderId === orderId && Array.isArray((value as PaymentsWorkspace).lines);
}

async function call(orderId: string, body?: Action & { contentHash?: string; revisionContentHash?: string }): Promise<Reply> {
  const response = await fetch(`/api/change-orders/${encodeURIComponent(orderId)}/payments`, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  const result: Reply = body ? json as Reply : { workspace: json as PaymentsWorkspace, redirectUrl: null, operationId: null, paypalOrderId: null };
  if (!isWorkspace(result.workspace, orderId)) throw new Error("The server returned incomplete payment records.");
  return result;
}

function lineState(line: PaymentLineView, operations: readonly OperationView[]): string {
  return lineProgress(line, operations).next;
}

const progressTones = { waiting: "bg-amber-50 text-amber-800", ready: "bg-brand-50 text-brand-800", settled: "bg-emerald-50 text-emerald-800" };
const lineAnchor = (line: Pick<PaymentLineView, "side" | "itemId">) => `payment-line-${line.side}-${line.itemId}`;

/** A link to one item's card, `#payment-line-<side>-<item>`, as the line's key. */
function lineFromHash(hash: string): string | null {
  const rest = decodeURIComponent(hash).replace(/^#?payment-line-/, "");
  if (rest === decodeURIComponent(hash).replace(/^#/, "")) return null;
  const side = rest.startsWith("baseline-") ? "baseline" : rest.startsWith("proposed-") ? "proposed" : null;
  return side ? `${side}:${rest.slice(side.length + 1)}` : null;
}

/** Every item of the version in one table, as the approved items are: select a row to act on it in the side card. */
function PaymentLines({ workspace, selected, onSelect }: { workspace: PaymentsWorkspace; selected: string | null; onSelect: (key: string) => void }) {
  const totals = paymentScopeTotals(workspace.lines);
  return <div aria-label={`Items in V${workspace.version}`}>
    <p className="mb-2 text-[11px] leading-relaxed text-slate-600">Each item keeps its own progress. Select one to act on it alone.{totals.releasedCents > 0 ? ` ${money(totals.releasedCents)} of holds released so far.` : ""}</p>
    <div className="max-h-[640px] overflow-auto rounded-lg border border-[var(--line)]">
      <table className="w-full min-w-[680px] border-collapse text-left text-[12px]">
        <thead className="sticky top-0 z-10 bg-[var(--canvas)] text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
          <tr><th className="px-3 py-2 font-medium">Item</th><th className="px-3 py-2 font-medium">Progress</th><th className="px-3 py-2 text-right font-medium">Held</th><th className="px-3 py-2 text-right font-medium">Net captured</th><th className="px-3 py-2 font-medium">Next step</th><th className="w-8" /></tr>
        </thead>
        <tbody>{workspace.lines.map((line) => {
          const key = lineKey(line);
          const progress = lineProgress(line, workspace.operations);
          return <tr key={key} id={lineAnchor(line)} onClick={() => onSelect(key)} aria-selected={selected === key}
            className={`scroll-mt-24 cursor-pointer border-t border-[var(--line)] align-top transition-colors hover:bg-brand-50/60 ${selected === key ? "bg-brand-50" : ""}`}>
            <td className="px-3 py-2.5"><button type="button" onClick={(event) => { event.stopPropagation(); onSelect(key); }} className={`text-left font-medium hover:underline ${line.cancellation ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>{line.label}</button><span className="block text-[10px] text-[var(--muted)]">{roleLabel(line)}</span></td>
            <td className="px-3 py-2.5"><span className={`inline-block whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-medium ${progressTones[progress.tone]}`}>{progress.label}</span></td>
            <td className="px-3 py-2.5 text-right tabular-nums">{money(line.heldCents)}</td>
            <td className="px-3 py-2.5 text-right tabular-nums">{money(line.capturedCents - line.refundedCents)}<span className="block text-[10px] text-[var(--muted)]">Target {money(line.targetCents)}</span></td>
            <td className="max-w-[260px] px-3 py-2.5 text-[11px] leading-relaxed text-slate-600">{progress.next}</td>
            <td className="pr-3 pt-3 text-[var(--muted)]"><ChevronRight className="h-3.5 w-3.5" /></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="mt-2 text-[10px] leading-relaxed text-slate-500">Net captured = completed captures minus completed refunds. Pending results do not count as settled money. Check any open PayPal operations before continuing.</p>
  </div>;
}

/** One item's side card beside the table, as the approved items have. A click beside it or Escape closes it. */
function LineDrawer({ line, operations, onClose, children }: { line: PaymentLineView; operations: readonly OperationView[]; onClose: () => void; children: React.ReactNode }) {
  const progress = lineProgress(line, operations);
  return <>
    {/* PayPal's own popup overlay sits above this, so a click on it never closes a checkout. */}
    <div aria-hidden className="fixed inset-0 z-30" onClick={onClose} />
    <aside role="dialog" aria-labelledby="line-drawer-title" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l border-[var(--line)] bg-white shadow-2xl">
      <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 id="line-drawer-title" className="text-[15px] font-semibold leading-snug">{line.label}</h3>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">{roleLabel(line)}</p>
          <p className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${progressTones[progress.tone]}`}>{progress.label}</p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px]">{children}</div>
    </aside>
  </>;
}

/** `designer`: the designer's view, where the supplier steps are done together in the workbench. */
export function PaymentsPanel({ order, designer = false, onChange }: { order: FrozenChangeOrder; designer?: boolean; onChange?: () => void }) {
  const readiness = useTryReadiness(order.projectKey);
  const [workspace, setWorkspace] = useState<PaymentsWorkspace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, dispatchFeedback] = useReducer(paymentFeedback, emptyPaymentFeedback);
  const error = feedbackMessage(feedback);
  const [notice, setNotice] = useState<ReturnType<typeof paymentReturnNotice>>(null);
  const mutating = useRef(false);
  const loadSequence = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, BatchResult>>({});
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);
  // A reminder or the guide links to one item as #payment-line-…: its card opens, here or after the page loads.
  useEffect(() => {
    const opened = () => { const key = lineFromHash(window.location.hash); if (key) setSelected(key); };
    window.addEventListener("hashchange", opened);
    return () => window.removeEventListener("hashchange", opened);
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = (await call(order.id)).workspace;
      if (sequence !== loadSequence.current) return;
      setWorkspace(next); dispatchFeedback({ type: "records_loaded" });
    }
    catch (cause) { if (sequence === loadSequence.current) dispatchFeedback({ type: "records_failed", message: cause instanceof Error ? cause.message : "Payment records could not be loaded." }); }
  }, [order.id]);
  usePaymentRefresh(order.projectKey, load);

  useEffect(() => {
    dispatchFeedback({ type: "action_started" });
    void load().then(() => {
      // The section renders after loading, so the browser could not jump to #payments by itself.
      // A reminder links straight to one item's card.
      const target = window.location.hash === "#payments" || window.location.hash.startsWith("#payment-line-") ? decodeURIComponent(window.location.hash.slice(1)) : null;
      const linked = lineFromHash(window.location.hash);
      if (linked) setSelected(linked);
      if (target) window.requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "start" }));
    });
    const returned = new URLSearchParams(window.location.search).get("paypal");
    setNotice(paymentReturnNotice(returned));
  }, [load]);

  /** Runs one step; returns the server's reply, or null when the step did not start or failed. */
  async function request(action: Action, key: string): Promise<Reply | null> {
    if (mutating.current || readiness.blocked) return null;
    mutating.current = true; setBusy(key); dispatchFeedback({ type: "action_started" });
    ++loadSequence.current;
    try {
      const result = await call(order.id, { ...action, ...("itemId" in action ? { contentHash: order.contentHash, revisionContentHash: order.revisionContentHash } : {}) });
      ++loadSequence.current;
      setWorkspace(result.workspace);
      onChange?.();
      if (result.redirectUrl) { setBusy("redirect"); window.location.assign(result.redirectUrl); }
      return result;
    } catch (cause) {
      dispatchFeedback({ type: "action_failed", message: cause instanceof Error ? cause.message : "The payment step could not be started." });
      await load();
      return null;
    } finally {
      mutating.current = false;
      setBusy((current) => current === "redirect" ? current : null);
      paymentChanged(order.projectKey);
    }
  }
  const run = async (action: Action, key: string) => !!await request(action, key);

  /**
   * The supplier steps of several lines in one go: for each ticked line, in turn, its
   * supplier record and then its PayPal step, through the same endpoint as one line.
   * The server checks each line on its own; a refused line keeps its reason and the run goes on.
   */
  async function runBatch(mode: BatchMode, items: { key: string; reference: string }[]) {
    if (mutating.current || readiness.blocked || !workspace) return;
    mutating.current = true; setBusy(`batch:${mode}`); dispatchFeedback({ type: "action_started" });
    ++loadSequence.current;
    let current = workspace;
    try {
      for (const item of items) {
        setResults((previous) => ({ ...previous, [item.key]: { mode, state: "running" } }));
        try {
          // A line takes a few steps at most: the supplier record, a capture per hold, and a release of what stays held.
          for (let guard = 0; guard < 4; guard++) {
            const line = current.lines.find((candidate) => lineKey(candidate) === item.key);
            const step = line && nextBatchStep(line, mode);
            if (!line || !step) break;
            const ref = { itemId: line.itemId, side: line.side };
            let action: Action;
            if (step.kind === "supplier_confirmation") {
              const terms = line.confirmedTerms;
              if (!terms) throw new Error("This item has no confirmed terms to check the supplier against.");
              action = { action: "supplier_order", quantity: terms.quantity, unitPriceCents: terms.unitPriceCents, taxCents: terms.taxCents, freightCents: terms.freightCents, inStock: true, leadTimeDays: null, reference: item.reference.trim(), note: "", ...ref };
            } else if (step.kind === "supplier_credit") action = { action: "supplier_credit", creditCents: step.amountCents, reference: item.reference.trim(), note: "", ...ref };
            else action = { action: step.kind === "capture" ? "capture" : step.kind === "void" ? "release" : "refund", ...ref };
            current = (await call(order.id, { ...action, contentHash: order.contentHash, revisionContentHash: order.revisionContentHash })).workspace;
            setWorkspace(current);
          }
          const done = current.lines.find((candidate) => lineKey(candidate) === item.key);
          const finished = current;
          setResults((previous) => ({ ...previous, [item.key]: { mode, state: "done", text: done ? lineProgress(done, finished.operations).label : "Done" } }));
        } catch (cause) {
          setResults((previous) => ({ ...previous, [item.key]: { mode, state: "refused", text: cause instanceof Error ? cause.message : "This item could not be completed." } }));
          try { current = (await call(order.id)).workspace; setWorkspace(current); } catch { /* the next line uses the last records read */ }
        }
      }
      dispatchFeedback({ type: "records_loaded" });
      onChange?.();
    } finally {
      ++loadSequence.current;
      mutating.current = false;
      setBusy(null);
      paymentChanged(order.projectKey);
    }
  }

  /** Cancels an item of this version through the project's item endpoint, then reloads this version's records. */
  async function cancelItem(line: PaymentLineView, reason: CancellationReason, note: string): Promise<boolean> {
    if (mutating.current || readiness.blocked || !workspace) return false;
    mutating.current = true; setBusy(`cancel-item:${line.side}:${line.itemId}`); dispatchFeedback({ type: "action_started" });
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(workspace.projectKey)}/item-holds`, {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_item", itemId: line.itemId, side: line.side, reason, note }),
      });
      const json = await response.json().catch(() => null) as { error?: string; details?: string[] } | null;
      if (!response.ok) throw new Error([json?.error ?? `Request failed (${response.status}).`, ...(json?.details ?? [])].join(" "));
      await load();
      onChange?.();
      return true;
    } catch (cause) {
      dispatchFeedback({ type: "action_failed", message: cause instanceof Error ? cause.message : "The item could not be cancelled." });
      await load();
      return false;
    } finally {
      mutating.current = false;
      setBusy(null);
      paymentChanged(order.projectKey);
    }
  }

  if (!workspace) return <section id="payments" className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><p className="flex items-center gap-2 text-[12px] text-slate-500">{error ?? <><LoaderCircle className="h-4 w-4 animate-spin" />Loading payment records…</>}</p></section>;
  const open = workspace.operations.filter((operation) => operation.status === "pending" || operation.status === "unknown");
  const plan = workspace.plan;
  const disabled = Boolean(busy) || readiness.blocked;
  const toHold = workspace.lines.flatMap((line) => line.steps.filter((step) => step.kind === "authorize" && step.available));
  const pay: LinePayment = { checkout: workspace.checkout, savedMethod: workspace.savedMethod, request };
  const openLine = workspace.lines.find((line) => lineKey(line) === selected) ?? null;

  return <section id="payments" aria-labelledby="payments-title" className="mb-5 scroll-mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-center gap-2"><h2 id="payments-title" className="mr-auto flex items-center gap-2 text-[16px] font-semibold"><CircleDollarSign className="h-4.5 w-4.5 text-[var(--primary)]" />Payments · V{workspace.version}</h2>{workspace.savedMethod && !workspace.canRemoveSaved && <span className="text-[11px] text-[var(--muted)]">Paid with {savedMethodName(workspace.savedMethod)}</span>}<span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-800">PayPal Sandbox · test money</span><button onClick={() => void load()} disabled={Boolean(busy)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Reload</button></div>
    <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">Amounts come from recorded PayPal results; a step counts only after PayPal confirms it.</p>
    {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error}</p>}
    {notice && <div role="status" className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900"><span className="flex-1">{notice.text}</span><button aria-label="Dismiss" onClick={() => setNotice(null)}><X className="h-3.5 w-3.5" /></button></div>}
    {error && <p role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900">{error}</p>}
    {workspace.reason && <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />{workspace.reason}</p>}
    {workspace.savedMethod && (workspace.canRemoveSaved || (workspace.checkout && toHold.length > 1)) && <div className="mt-4 space-y-3">
      {workspace.canRemoveSaved && <SavedMethodCard method={workspace.savedMethod} canRemove={workspace.canRemoveSaved} busy={busy === "remove_saved"} disabled={disabled} onRemove={() => void run({ action: "remove_saved" }, "remove_saved")} />}
      {workspace.checkout && toHold.length > 1 && <button type="button" disabled={disabled} onClick={() => void run({ action: "hold_saved" }, "hold_saved")}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50">{busy === "hold_saved" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LockKeyhole className="h-3.5 w-3.5" />}Hold all {toHold.length} new items · {money(toHold.reduce((total, step) => total + step.amountCents, 0))} with {savedMethodName(workspace.savedMethod)}</button>}
    </div>}

    {open.length > 0 && <div className="mt-4 space-y-3">{open.map((operation) => <div key={operation.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-[12px] leading-relaxed text-amber-950">
      <p className="font-semibold">{kindLabels[operation.kind]} · {money(operation.amountCents)} · {operation.itemLabel ?? "item"}{operation.version ? ` · V${operation.version}` : ""}</p>
      <p className="mt-1">{operation.status === "unknown" ? "PayPal may or may not have completed this step. Check its status; Setti will not start a replacement." : operation.kind !== "authorize" ? "Waiting to be sent to PayPal again with the same request id." : operation.paypalOrderId ? operation.failureCode === "AUTHORIZATION_PENDING" ? "PayPal is reviewing this authorization. Nothing is held until PayPal creates it." : "Waiting for the client to approve on PayPal." : "Preparing the PayPal checkout."}{operation.failureMessage ? ` ${operation.failureMessage}` : ""}</p>
      {operation.canContinue && operation.paypalOrderId && operation.kind === "authorize" && workspace.checkout?.paypalClientId && !readiness.blocked && <div className="mt-3 max-w-[380px]">
        <PayPalButtons clientId={workspace.checkout.paypalClientId} disabled={disabled}
          createOrder={async () => operation.paypalOrderId!}
          onApprove={async () => { await run({ action: "check", operationId: operation.id }, `check:${operation.id}`); }}
          onCancel={async () => { await run({ action: "cancel", operationId: operation.id }, `cancel:${operation.id}`); }}
          onError={() => { dispatchFeedback({ type: "action_failed", message: "PayPal could not finish this hold. Nothing is held; check this same checkout or try again." }); void load(); }} />
      </div>}
      {workspace.canReconcile ? <div className="mt-3 flex flex-wrap gap-3">
        {operation.canContinue && operation.approvalUrl && !readiness.blocked && <a href={operation.approvalUrl} className="inline-flex items-center gap-1.5 font-medium underline">Open PayPal in this tab instead<ArrowUpRight className="h-3.5 w-3.5" /></a>}
        {operation.canCheck && <button onClick={() => void run({ action: "check", operationId: operation.id }, `check:${operation.id}`)} disabled={disabled} className="inline-flex items-center gap-1.5 font-semibold underline disabled:opacity-50">{busy === `check:${operation.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check PayPal status</button>}
        {operation.canCancel && <button onClick={() => void run({ action: "cancel", operationId: operation.id }, `cancel:${operation.id}`)} disabled={disabled} className="font-medium underline disabled:opacity-50">Leave checkout</button>}
      </div> : null}
    </div>)}</div>}

    {workspace.lines.length > 0 && <><div className="mt-4"><PaymentWorkbench designer={designer} workspace={workspace} order={order} operations={workspace.operations} busy={busy} disabled={disabled || !workspace.canAct} results={results} onRun={(mode, items) => void runBatch(mode, items)} onOpen={setSelected}
        allItems={<PaymentLines workspace={workspace} selected={selected} onSelect={setSelected} />} /></div>
      {openLine && <LineDrawer line={openLine} operations={workspace.operations} onClose={() => setSelected(null)}>
        <LineDetails key={lineKey(openLine)} line={openLine} operations={workspace.operations} version={workspace.version} busy={busy} disabled={disabled} canAct={workspace.canAct} canReconcile={workspace.canReconcile} pay={pay} onAction={(action, key) => run({ ...action, itemId: openLine.itemId, side: openLine.side } as Action, key)} onCheck={(operationId) => void run({ action: "check", operationId }, `check:${operationId}`)} onCancelItem={(reason, note) => cancelItem(openLine, reason, note)} />
      </LineDrawer>}
      {/* Fees are evidence, not a step: folded so the steps stay at the top of the page. */}
      <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-[12px] font-medium">PayPal fees and merchant net</summary>
        <PaymentFees lines={workspace.lines} {...(workspace.canReconcile ? { onRefresh: () => void run({ action: "fees" }, "fees"), refreshing: busy === "fees", disabled } : {})} />
      </details></>}

    {plan && <>
      {workspace.others.lineCount > 0 && <p className="mt-4 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">{workspace.others.lineCount} other quote lines ({money(workspace.others.targetCents)}) are outside this change. Setti shows their amounts but runs no payment step for them in this demo; they are not authorized or paid.</p>}
      {plan.status === "blocked" && plan.blockers.length > 0 && <div className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900"><p className="font-semibold">New payment steps wait until these are resolved</p><ul className="mt-2 list-disc space-y-1 pl-4">{plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
      <details className="mt-4 rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-[12px] font-medium">Whole-quote funding preview · every line</summary>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">This is the remaining plan, not a list of completed payments. Each action affects only its own item. If every line of V{plan.version} were funded through Setti. Funding facts checked {dateTime(plan.factsAsOf)} PT.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[{ label: "Planned new authorization", amount: plan.money.newAuthorizationCents }, { label: "Planned hold release", amount: plan.money.releaseCents }, { label: "Planned capture / charge", amount: plan.money.chargeCents }, { label: "Planned refund", amount: plan.money.refundCents }].map((tile) => <div key={tile.label} className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-500">{tile.label}</p><p className="mt-1 text-[16px] font-semibold tabular-nums">{tile.amount === null ? "Unavailable" : money(tile.amount)}</p></div>)}</div>
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

/** A line action without its line reference, one variant at a time (so each keeps its own fields). */
type LineActionInput = Extract<Action, { itemId: string }> extends infer A ? A extends unknown ? Omit<A, "itemId" | "side"> : never : never;
/** What a line needs to take the client's payment: the payment choices, the saved method and the raw step request. */
interface LinePayment { checkout: CheckoutView | null; savedMethod: SavedMethodView | null; request: (action: Action, key: string) => Promise<Reply | null> }


/** What one item needs in its side card: its amounts, the supplier's records, and each step it can take next. */
function LineDetails({ line, operations, version, busy, disabled, canAct, canReconcile, pay, onAction, onCheck, onCancelItem }: { line: PaymentLineView; operations: readonly OperationView[]; version: number; busy: string | null; disabled: boolean; canAct: boolean; canReconcile: boolean; pay: LinePayment; onAction: (action: LineActionInput, key: string) => Promise<boolean>; onCheck: (operationId: string) => void; onCancelItem: (reason: CancellationReason, note: string) => Promise<boolean> }) {
  const demo = useDemoMode();
  const [confirming, setConfirming] = useState<PaymentStep["kind"] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [form, setForm] = useState<"supplier_confirmation" | "supplier_credit" | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [save, setSave] = useState(true);
  const popup = useRef<string | null>(null);
  const retainedCost = line.confirmedTerms?.purpose === "retained_cost";
  const key = (kind: string) => `${kind}:${line.side}:${line.itemId}`;
  const tiles = [
    { label: `Confirmed in V${version}${line.cancellation ? " · cancelled" : ""}`, amount: line.cancelledTargetCents ?? line.targetCents },
    { label: "Authorized (held)", amount: line.heldCents },
    { label: "Captured", amount: line.capturedCents },
    { label: "Refunded", amount: line.refundedCents },
    { label: "Actually released hold", amount: line.releasedCents },
  ];
  const pending = line.captures.find((capture) => capture.status === "pending")?.operationId ?? line.refunds.find((refund) => refund.status === "pending")?.operationId ?? null;
  const progress = lineProgress(line, operations);
  return <div>
    <div className="grid grid-cols-2 gap-2">{tiles.map((tile) => <div key={tile.label} className="rounded-lg bg-slate-50 p-2.5"><p className="text-[10px] text-slate-500">{tile.label}</p><p className="mt-0.5 text-[15px] font-semibold tabular-nums">{money(tile.amount)}</p></div>)}</div>
    {line.nonRefundable && <p className="mt-2 text-[12px] text-slate-700"><span className="font-medium">Non-refundable</span> · {nonRefundableText(line.nonRefundable)}</p>}
    <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-slate-700"><ShieldCheck className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${progress.tone === "settled" ? "text-emerald-600" : progress.tone === "waiting" ? "text-amber-600" : "text-brand-600"}`} />{lineState(line, operations)}</p>
    {canReconcile && pending && operations.find((operation) => operation.id === pending)?.canCheck && <button onClick={() => onCheck(pending)} disabled={disabled} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-amber-900 underline disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />Check the pending PayPal result</button>}

    {line.supplierEvents.length > 0 && <ul className="mt-3 space-y-1.5">{line.supplierEvents.map((event) => <li key={event.id} className="flex items-start gap-2 rounded-lg bg-brand-50/60 p-2.5 text-[11px] leading-relaxed text-brand-950"><Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><strong className="font-semibold">{event.kind === "order_confirmed" ? retainedCost ? "Supplier confirmed the retained cost" : "Supplier confirmed the order" : "Supplier credited the return"}</strong> · {demo ? "demo record " : ""}entered by the designer · {dateTime(event.createdAt)} PT<br />{event.kind === "order_confirmed" ? retainedCost ? `Retained cost ${money(event.totalCents)} total, including applicable tax and delivery` : `${event.quantity} × ${money(event.unitPriceCents)} + tax ${money(event.taxCents)} + delivery ${money(event.freightCents)} = ${money(event.totalCents)} · in stock${event.leadTimeDays !== null ? ` · lead time ${event.leadTimeDays} days` : ""}` : `Credit ${money(event.totalCents)}`} · reference {event.reference}{event.note ? ` · ${event.note}` : ""}</span></li>)}</ul>}

    {line.steps.length > 0 && <div className="mt-3 space-y-2">{line.steps.map((step, index) => <div key={index} className="rounded-lg border border-slate-100 p-3">
      <div className="flex flex-wrap items-center gap-3">
        {step.available ? <StepButton step={step} savedMethod={pay.savedMethod} retainedCost={retainedCost} busy={busy === key(step.kind) || (step.kind === "authorize" && busy === "redirect")} disabled={disabled} onClick={() => {
          if (step.kind === "authorize") {
            if (pay.savedMethod) void onAction({ action: "authorize", via: "saved" }, key(step.kind));
            else if (pay.checkout) setChoosing(!choosing);
            else void onAction({ action: "authorize" }, key(step.kind));
          }
          else if (step.kind === "supplier_confirmation" || step.kind === "supplier_credit") setForm(form === step.kind ? null : step.kind);
          else setConfirming(confirming === step.kind ? null : step.kind);
        }} /> : <span className="rounded-lg bg-slate-100 px-3 py-2 text-[12px] font-medium text-slate-500">{stepLabel(step)}</span>}
        <p className="min-w-[200px] flex-1 text-[11px] leading-relaxed text-slate-500"><strong className="font-medium text-slate-600">{step.actor === "client" ? "Client step" : "Designer step"}.</strong> {step.note}{!canAct ? demo ? " Open this version from the owning demo session to act on it." : " Only the project's designer or client can act on it." : ""}</p>
      </div>
      {step.available && canAct && step.kind === "authorize" && choosing && !pay.savedMethod && pay.checkout && <div className="mt-3 rounded-lg bg-[var(--canvas)] p-3">
        <p className="mb-3 text-[11px] leading-relaxed text-slate-600">Hold {money(step.amountCents)} for {line.label}. PayPal opens in a window over this page; nothing is charged until the supplier confirms.</p>
        <PayMethodChooser options={pay.checkout} disabled={disabled} testCardBusy={busy === key("test_card")} save={save} onSaveChange={setSave}
          onTestCard={() => void onAction({ action: "authorize", via: "test_card", save }, key("test_card")).then((ok) => { if (ok) setChoosing(false); })}
          paypal={{
            createOrder: async () => {
              const reply = await pay.request({ action: "authorize", via: "popup", save, itemId: line.itemId, side: line.side }, key(step.kind));
              if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start.");
              popup.current = reply.operationId;
              return reply.paypalOrderId;
            },
            onApprove: async () => { if (popup.current) { onCheck(popup.current); setChoosing(false); } },
            onCancel: async () => { if (popup.current) await pay.request({ action: "cancel", operationId: popup.current }, `cancel:${popup.current}`); },
            onError: () => { if (popup.current) onCheck(popup.current); },
          }} />
      </div>}
      {step.available && canAct && confirming === step.kind && confirmations[step.kind] && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 p-3 text-[12px] text-amber-950"><span className="flex-1">{confirmations[step.kind]!.text(money(step.amountCents))}</span><button disabled={disabled} onClick={() => void onAction({ action: lineActions[step.kind]! }, key(step.kind)).then((ok) => { if (ok) setConfirming(null); })} className="rounded-lg bg-amber-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50">{confirmations[step.kind]!.button}</button><button onClick={() => setConfirming(null)} className="font-medium underline">Not now</button></div>}
      {step.available && canAct && form === "supplier_confirmation" && step.kind === "supplier_confirmation" && <SupplierOrderForm line={line} disabled={disabled} onSubmit={(input) => onAction({ action: "supplier_order", ...input }, key(step.kind)).then((ok) => { if (ok) setForm(null); })} />}
      {step.available && canAct && form === "supplier_credit" && step.kind === "supplier_credit" && <SupplierCreditForm amountCents={step.amountCents} itemId={line.itemId} disabled={disabled} onSubmit={(input) => onAction({ action: "supplier_credit", ...input }, key(step.kind)).then((ok) => { if (ok) setForm(null); })} />}
    </div>)}</div>}

    {line.cancellation && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700"><Ban className="h-3.5 w-3.5" />Cancelled by the studio</p><CancellationRecord cancellation={line.cancellation} /></div>}
    {line.canCancelItem && canAct && (cancelling
      ? <div className="mt-3 max-w-[440px] rounded-lg border border-red-100 p-3"><CancelItemForm itemName={line.label} heldCents={line.heldCents} disabled={disabled} busy={busy === `cancel-item:${line.side}:${line.itemId}`}
        onBack={() => setCancelling(false)} onSubmit={(reason, note) => void onCancelItem(reason, note).then((ok) => { if (ok) setCancelling(false); })} /></div>
      : <button type="button" disabled={disabled} onClick={() => setCancelling(true)} className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-red-700 hover:underline disabled:opacity-50"><Ban className="h-3.5 w-3.5" />{line.heldCents > 0 ? "Cancel hold…" : "Cancel item…"}</button>)}

    <PayPalRecords line={line} />
  </div>;
}

/** The PayPal records behind an item, compact enough for the side card. */
function PayPalRecords({ line }: { line: PaymentLineView }) {
  if (!line.holds.length && !line.captures.length && !line.refunds.length) return null;
  const row = "rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed";
  const id = "break-all font-mono text-[10px] text-slate-500";
  return <section aria-label="PayPal records" className="mt-4">
    <h4 className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">PayPal Sandbox records</h4>
    <ul className="mt-1.5 space-y-1.5">
      {line.holds.map((hold) => <li key={hold.id} className={row}>
        <p className="font-medium text-slate-700">Hold · {money(hold.amountCents)} · {hold.status}{hold.heldCents ? ` · ${money(hold.heldCents)} held` : ""}{hold.capturedCents ? ` · ${money(hold.capturedCents)} captured` : ""}{hold.releasedCents ? ` · ${money(hold.releasedCents)} released` : ""}</p>
        <p className={id}>{hold.paypalAuthorizationId} · order {hold.paypalOrderId}</p>
        <p className="text-[10px] text-slate-500">{hold.version ? `For V${hold.version} · ` : ""}honor period {hold.honorExpiresAt ? dateTime(hold.honorExpiresAt) : "—"} · expires {hold.expiresAt ? dateTime(hold.expiresAt) : "not reported"}</p>
      </li>)}
      {line.captures.map((capture) => <li key={capture.id} className={row}>
        <p className="font-medium text-slate-700">Capture · {money(capture.amountCents)}{capture.finalCapture ? " · final" : ""} · {capture.status}{capture.refundedCents ? ` · ${money(capture.refundedCents)} refunded` : ""}{capture.pendingRefundCents ? ` (+${money(capture.pendingRefundCents)} pending)` : ""}</p>
        <p className={id}>{capture.paypalCaptureId}{capture.authorizationId ? ` · from ${line.holds.find((hold) => hold.id === capture.authorizationId)?.paypalAuthorizationId ?? "hold"}` : ""}</p>
        <p className="text-[10px] text-slate-500">{dateTime(capture.createdAt)}</p>
      </li>)}
      {line.refunds.map((refund) => <li key={refund.id} className={row}>
        <p className="font-medium text-slate-700">Refund · {money(refund.amountCents)} · {refund.status}</p>
        <p className={id}>{refund.paypalRefundId} · from {line.captures.find((capture) => capture.id === refund.captureId)?.paypalCaptureId ?? "—"}</p>
        <p className="text-[10px] text-slate-500">{dateTime(refund.createdAt)}</p>
      </li>)}
    </ul>
  </section>;
}

function StepButton({ step, savedMethod, retainedCost, busy, disabled, onClick }: { step: PaymentStep; savedMethod: SavedMethodView | null; retainedCost: boolean; busy: boolean; disabled: boolean; onClick: () => void }) {
  const label = step.kind === "authorize" ? savedMethod ? `Hold ${money(step.amountCents)} with ${savedMethodName(savedMethod)}` : `Hold ${money(step.amountCents)} · choose how to pay` : step.kind === "supplier_confirmation" ? retainedCost ? "Add retained-cost confirmation" : "Add supplier confirmation" : step.kind === "supplier_credit" ? "Add supplier credit" : stepLabel(step);
  return <button onClick={onClick} disabled={disabled} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}{label}</button>;
}

function SupplierOrderForm({ line, disabled, onSubmit }: { line: PaymentLineView; disabled: boolean; onSubmit: (input: { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean; leadTimeDays: number | null; reference: string; note: string }) => void }) {
  const terms = line.confirmedTerms;
  const retainedCost = terms?.purpose === "retained_cost";
  const [quantity, setQuantity] = useState(String(terms?.quantity ?? ""));
  const [unit, setUnit] = useState(centsText(terms?.unitPriceCents ?? null));
  const [tax, setTax] = useState(centsText(terms?.taxCents ?? null));
  const [freight, setFreight] = useState(centsText(terms?.freightCents ?? null));
  const [leadTime, setLeadTime] = useState("");
  const [inStock, setInStock] = useState(true);
  const demo = useDemoMode();
  const [reference, setReference] = useState(() => demo ? demoSupplierNumber("order", line.itemId) : "");
  const [note, setNote] = useState("");
  const amounts = [parseDollars(unit), parseDollars(tax), parseDollars(freight)];
  const count = Number(quantity), days = leadTime.trim() ? Number(leadTime) : null;
  const valid = Number.isSafeInteger(count) && count >= 1 && amounts.every((amount) => amount.value !== null) && (days === null || (Number.isSafeInteger(days) && days >= 0)) && reference.trim().length > 0 && inStock;
  return <form className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit({ quantity: count, unitPriceCents: amounts[0].value!, taxCents: amounts[1].value!, freightCents: amounts[2].value!, inStock, leadTimeDays: days, reference: reference.trim(), note: note.trim() }); }}>
    <div><p className="text-[12px] font-semibold text-slate-800">{demo ? "Demo supplier" : "Supplier"} {retainedCost ? "retained-cost confirmation" : "confirmation"}</p><p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{demo ? "There is no real supplier in this demo, so the confirmation is filled in from the client-confirmed line. Check it and save it." : "Filled in from the client-confirmed line. Enter the supplier's reference and check the rest."}</p></div>
    <p className="text-[11px] leading-relaxed text-slate-600">{retainedCost ? "Confirm the supplier's total retained cost for the cancelled or replaced item. The client-confirmed total already includes applicable tax and delivery. Closing the original hold after capturing this cost releases the unused balance." : `Enter what the supplier confirmed. ${demo ? "This demo record is entered by the designer." : "The designer enters this record."} If any amount differs from the client-confirmed terms, Setti refuses it and the change goes back to pricing and client confirmation.`}</p>
    <div className="grid grid-cols-2 gap-3"><Field label={retainedCost ? "Cost items" : "Quantity"}><input value={quantity} onChange={(event) => setQuantity(event.target.value)} readOnly={retainedCost} inputMode="numeric" className={inputClass} /></Field><Field label={retainedCost ? "Total retained cost · USD" : "Unit price · USD"} error={amounts[0].error ?? undefined}><input value={unit} onChange={(event) => setUnit(event.target.value)} inputMode="decimal" className={inputClass} /></Field><Field label="Line tax · USD" error={amounts[1].error ?? undefined}><input value={tax} onChange={(event) => setTax(event.target.value)} readOnly={retainedCost} inputMode="decimal" className={inputClass} /></Field><Field label="Line delivery · USD" error={amounts[2].error ?? undefined}><input value={freight} onChange={(event) => setFreight(event.target.value)} readOnly={retainedCost} inputMode="decimal" className={inputClass} /></Field></div>
    <div className="grid grid-cols-2 gap-3"><Field label={retainedCost ? "Supplier's reference" : "Supplier's order number"}><input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} placeholder="From the supplier's confirmation" className={inputClass} /></Field>{!retainedCost && <Field label="Lead time · days (optional)"><input value={leadTime} onChange={(event) => setLeadTime(event.target.value)} inputMode="numeric" className={inputClass} /></Field>}<Field label="Note (optional)"><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} className={inputClass} /></Field></div>
    <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={inStock} onChange={(event) => setInStock(event.target.checked)} />{retainedCost ? "The supplier confirmed this total retained cost for the cancellation or replacement." : "The supplier confirmed the item is in stock and accepted the order."}</label>
    <button type="submit" disabled={disabled || !valid} className="rounded-lg bg-slate-900 px-3.5 py-2 text-[12px] font-semibold text-white disabled:bg-slate-200 disabled:text-slate-400">{retainedCost ? "Save retained-cost confirmation" : "Save supplier confirmation"}</button>
  </form>;
}

function SupplierCreditForm({ amountCents, itemId, disabled, onSubmit }: { amountCents: number; itemId: string; disabled: boolean; onSubmit: (input: { creditCents: number; reference: string; note: string }) => void }) {
  const [credit, setCredit] = useState(centsText(amountCents));
  const demo = useDemoMode();
  const [reference, setReference] = useState(() => demo ? demoSupplierNumber("credit", itemId) : "");
  const [note, setNote] = useState("");
  const parsed = parseDollars(credit);
  const valid = parsed.value !== null && reference.trim().length > 0;
  return <form className="mt-3 space-y-3 rounded-lg bg-slate-50 p-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit({ creditCents: parsed.value!, reference: reference.trim(), note: note.trim() }); }}>
    <div><p className="text-[12px] font-semibold text-slate-800">{demo ? "Demo supplier credit" : "Supplier credit"}</p><p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{demo ? "There is no real supplier in this demo, so the credit note is filled in from the confirmed refund. Check it and save it." : "Filled in from the confirmed refund. Enter the supplier's credit note number and check the amount."}</p></div>
    <p className="text-[11px] leading-relaxed text-slate-600">The credit the supplier issued for the return. It must equal the confirmed refund of {money(amountCents)}; a different credit means the non-refundable fees changed and the return goes back to pricing.</p>
    <div className="grid grid-cols-2 gap-3"><Field label="Supplier credit · USD" error={parsed.error ?? undefined}><input value={credit} onChange={(event) => setCredit(event.target.value)} inputMode="decimal" className={inputClass} /></Field><Field label="Supplier's credit note number"><input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} placeholder="From the supplier's credit note" className={inputClass} /></Field><Field label="Note (optional)"><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} className={inputClass} /></Field></div>
    <button type="submit" disabled={disabled || !valid} className="rounded-lg bg-slate-900 px-3.5 py-2 text-[12px] font-semibold text-white disabled:bg-slate-200 disabled:text-slate-400">Save supplier credit</button>
  </form>;
}

function roleLabel(line: PaymentLineView): string {
  if (line.change === "replace") return line.side === "proposed" ? "Replacement product" : "Old product · replaced";
  return line.change === "quantity" ? "Quantity changed" : line.change === "remove" ? "Removed line" : line.change === "add" ? "Added line" : "Carried over";
}

function stepLabel(step: PaymentStep): string {
  const amount = money(step.amountCents);
  return { authorize: `Authorize ${amount}`, supplier_confirmation: "Supplier confirmation", capture: `Capture ${amount}`, void: `Release ${amount} hold`, supplier_credit: "Supplier credit", refund: `Refund ${amount}` }[step.kind];
}
