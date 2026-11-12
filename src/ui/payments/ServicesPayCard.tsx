"use client";

import { CalendarClock, Check, CreditCard, LoaderCircle, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ServicesPaymentView } from "@/payments/services-view";
import { shortMoney } from "../pricing/common";
import { CARD, SEND } from "../pricing/EditorFrame";
import { useDemoMode } from "../demo-mode";
import { useTryReadiness } from "../try/useTryReadiness";
import { PayPalButton } from "./PayPalButtons";
import { savedMethodName } from "./PaymentMethods";
import { paymentChanged, usePaymentRefresh } from "./usePaymentRefresh";

type Body = { action: "checkout" | "test_card"; save: boolean } | { action: "charge" } | { action: "approve" | "cancel" | "check"; operationId: string };
interface Reply { view: ServicesPaymentView; operationId: string | null; paypalOrderId: string | null }
type Method = "saved" | "card" | "paypal" | "paylater";

async function request(key: CaseKey, body?: Body): Promise<Reply> {
  const response = await fetch(`/api/quotes/${key}/services-payment`, {
    cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  return body ? json as Reply : { view: json as ServicesPaymentView, operationId: null, paypalOrderId: null };
}

const usd = (cents: number) => shortMoney(cents);
const small = "text-[9.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

/**
 * What the client still pays on a confirmed version, as one checkout card: what
 * is paid today, how to pay, then one button. In the demo the saved card is
 * PayPal's Sandbox test card, so paying with it runs that card through PayPal.
 * Once paid, the card turns into a short receipt.
 */
export function ServicesPayCard({ projectKey, orderId }: { projectKey: CaseKey; orderId: string }) {
  const demo = useDemoMode();
  const readiness = useTryReadiness(projectKey);
  const [view, setView] = useState<ServicesPaymentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [save, setSave] = useState(true);
  const [paidNow, setPaidNow] = useState<{ cents: number; method: string } | null>(null);
  const checkout = useRef<string | null>(null);

  const load = useCallback(async () => {
    try { setView((await request(projectKey)).view); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The payment could not be loaded."); }
  }, [projectKey]);
  usePaymentRefresh(projectKey, load);
  useEffect(() => { void load(); }, [load, readiness.blocked]);

  async function run(label: string, body: Body, paidWith?: string): Promise<Reply | null> {
    if (readiness.blocked) return null;
    const due = view?.dueCents ?? 0;
    setBusy(label); setError(null);
    try {
      const reply = await request(projectKey, body);
      setView(reply.view);
      if (due > 0 && reply.view.dueCents === 0) setPaidNow({ cents: due, method: paidWith ?? "PayPal" });
      return reply;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment did not finish. Reload to see what PayPal recorded.");
      void load();
      return null;
    } finally { setBusy(null); paymentChanged(projectKey); }
  }

  if (!view?.basis || view.basis.orderId !== orderId || !view.services.length) return null;
  const owed = view.services.filter((line) => line.targetCents > line.capturedCents);
  const paidLines = view.services.filter((line) => line.captures.some((capture) => capture.status === "completed"));

  // Paid: the card becomes its receipt.
  if (view.dueCents === 0) {
    if (!paidNow && !paidLines.length) return null;
    return <section className={`${CARD} overflow-hidden`} aria-label="Payment received">
      <div className="flex items-end justify-between gap-3 border-b border-[var(--line)] bg-[#fbfaf6] px-4 pb-[13px] pt-3.5">
        <div><span className={small}>Payment received{paidNow ? ` · ${day(new Date().toISOString())}` : ""}</span><h3 className="mt-[3px] text-[15px] font-bold">{paidNow ? `${usd(paidNow.cents)} paid` : "Design services paid"}</h3></div>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ink)] text-white"><Check className="h-4 w-4" strokeWidth={3} /></span>
      </div>
      <dl className="px-4 py-1 text-[12.5px]">
        {paidNow && <div className="flex justify-between gap-3 border-b border-[var(--line)] py-2.5"><dt className="text-[var(--muted)]">Method</dt><dd className="font-semibold">{paidNow.method}</dd></div>}
        <div className="flex justify-between gap-3 border-b border-[var(--line)] py-2.5"><dt className="text-[var(--muted)]">Confirmed</dt><dd className="font-semibold">By PayPal{paidNow ? ", just now" : ""}</dd></div>
        <div className="flex justify-between gap-3 py-2.5"><dt className="text-[var(--muted)]">Receipt</dt><dd><Link href="/inbox" className="font-semibold text-[var(--primary)] underline-offset-2 hover:underline">Open in Inbox</Link></dd></div>
      </dl>
    </section>;
  }

  const options = view.checkoutOptions;
  const saved = view.savedMethod;
  // The demo's saved card is PayPal's Sandbox test card: paying with it runs the test card through PayPal.
  const methods: { id: Method; title: string; detail: string; icon: typeof Wallet }[] = [
    ...(options?.testCard && saved?.kind === "card" ? [{ id: "saved" as const, title: savedMethodName(saved), detail: demo ? "Saved for this project · PayPal's Sandbox test card" : "Saved for this project", icon: CreditCard }] : []),
    ...(options?.paypalClientId ? [
      { id: "paypal" as const, title: "PayPal", detail: "Log in to PayPal to pay", icon: Wallet },
      { id: "paylater" as const, title: "Pay Later", detail: "Pay in 4 or monthly, with PayPal", icon: CalendarClock },
    ] : []),
    ...(options?.testCard && !(saved?.kind === "card") ? [{ id: "card" as const, title: "Debit or credit card", detail: "Visa •••• 0026 · PayPal's Sandbox test card", icon: CreditCard }] : []),
  ];
  const chosen = methods.find((entry) => entry.id === method)?.id ?? methods[0]?.id ?? null;
  const held = view.furnitureToHold;
  const canPay = view.canPay && !!options && !readiness.blocked;
  const title = owed.length === 1 ? `Pay for ${owed[0].label.charAt(0).toLowerCase()}${owed[0].label.slice(1)}` : "Pay for the design services";
  const payWithCard = () => void run(chosen === "saved" ? "saved" : "card", { action: "test_card", save: chosen === "card" && !!options?.canSave && save }, chosen === "saved" && saved ? savedMethodName(saved) : "Visa •••• 0026");

  return <section id="design-services" className={`${CARD} scroll-mt-5 overflow-hidden`} aria-label="Payment due">
    <div className="flex items-end justify-between gap-3 border-b border-[var(--line)] bg-[#fbfaf6] px-4 pb-[13px] pt-3.5">
      <div><span className={small}>Payment due</span><h3 className="mt-[3px] text-[15px] font-bold">{title}</h3></div>
      <div className="grid justify-items-end"><b className="text-[26px] font-bold leading-[1.1] tracking-[-0.02em] tabular-nums">{usd(view.dueCents)}</b><span className={small}>USD</span></div>
    </div>
    <div className="px-4 pb-0.5 pt-1">
      {owed.map((line) => <div key={line.itemId} className="flex justify-between gap-3 border-b border-dashed border-[var(--line)] py-[9px]">
        <div className="grid min-w-0 gap-px"><b className="text-[12.5px]">{line.label}</b><span className="text-[11px] text-[var(--muted)]">{line.capturedCents > 0 ? `${usd(line.capturedCents)} paid before · ${usd(line.targetCents)} in this version` : `${usd(line.targetCents)} in this version`}</span></div>
        <div className="grid justify-items-end gap-px text-right"><b className="text-[12.5px] tabular-nums">{usd(line.targetCents - line.capturedCents)}</b><span className="text-[11px] font-semibold text-[var(--primary)]">Paid today</span></div>
      </div>)}
      <div className="flex justify-between pb-1 pt-2.5 text-[13.5px] font-bold"><span>Due today</span><b className="tabular-nums">{usd(view.dueCents)}</b></div>
      {held.count > 0 && <div className="flex justify-between pb-2.5 text-[11.5px] text-[var(--muted)]"><span>Held on your card · {held.count} {held.count === 1 ? "item" : "items"}</span><span className="tabular-nums">{usd(held.cents)}</span></div>}
    </div>

    {canPay && methods.length > 0 && <div role="radiogroup" aria-label="Payment method" className="grid gap-1.5 border-t border-[var(--line)] px-4 pt-2.5">
      <span className={small}>Pay with</span>
      {methods.map((entry) => { const Icon = entry.icon; const on = entry.id === chosen; return <label key={entry.id} className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-2.5 ${on ? "border-[var(--ink)] shadow-[inset_0_0_0_1px_var(--ink)]" : "border-[var(--line)] hover:bg-[var(--canvas)]"}`}>
        <input type="radio" name={`pay-${orderId}`} checked={on} disabled={!!busy} onChange={() => setMethod(entry.id)} className="h-4 w-4 shrink-0 accent-[var(--ink)]" />
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-white text-slate-600"><Icon className="h-4 w-4" /></span>
        <span className="grid min-w-0"><b className="text-[13px]">{entry.title}</b><small className="truncate text-[11px] text-[var(--muted)]">{entry.detail}</small></span>
      </label>; })}
      {chosen !== "saved" && options?.canSave && <label className="mt-1 flex items-start gap-2 text-[11.5px] text-slate-600"><input type="checkbox" checked={save} disabled={!!busy} onChange={(event) => setSave(event.target.checked)} className="mt-0.5 accent-[var(--ink)]" /><span>Save it for this project&apos;s later holds</span></label>}
    </div>}

    {(view.canCheck || view.canFinish) && <div className="flex flex-wrap items-center gap-3 border-t border-[var(--line)] px-4 pt-3">
      {view.canCheck && view.checkout && <button type="button" disabled={!!busy} onClick={() => void run("check", { action: "check", operationId: view.checkout!.operationId })} className="inline-flex items-center gap-1.5 text-[12px] font-semibold underline disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />Check PayPal status</button>}
      {view.canFinish && <button type="button" disabled={!!busy} onClick={() => void run("charge", { action: "charge" })} className="inline-flex items-center gap-1.5 text-[12px] font-semibold underline disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />Finish the payment</button>}
    </div>}
    {(view.reason && !view.canPay && !view.canFinish) && <p className="border-t border-[var(--line)] px-4 pt-3 text-[11.5px] text-[var(--muted)]">{view.reason}</p>}
    {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="px-4 pt-3 text-[11.5px] text-amber-900">{readiness.notice ?? readiness.error}</p>}
    {error && <p role="alert" className="mx-4 mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}

    <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5 border-t border-[var(--line)] bg-[#fbfaf6] px-4 pb-3.5 pt-3">
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]"><LockKeyhole className="h-3.5 w-3.5" />Secured by PayPal</span>
      {busy ? <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />{chosen === "paypal" || chosen === "paylater" ? "Waiting for PayPal…" : "Processing…"}</span>
        : !canPay ? null
          : chosen === "paypal" || chosen === "paylater" ? <div className="w-[220px]"><PayPalButton clientId={options!.paypalClientId!} funding={chosen} disabled={!!busy}
            createOrder={async () => { const reply = await run("checkout", { action: "checkout", save: !!options?.canSave && save }); if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start."); checkout.current = reply.operationId; return reply.paypalOrderId; }}
            onApprove={async () => { if (checkout.current) await run("approve", { action: "approve", operationId: checkout.current }, chosen === "paylater" ? "PayPal Pay Later" : "PayPal"); }}
            onCancel={async () => { if (checkout.current) await run("cancel", { action: "cancel", operationId: checkout.current }); }}
            onError={() => { setError("PayPal could not finish the payment. Nothing is recorded as paid; try again."); void load(); }} /></div>
            : <button type="button" onClick={payWithCard} className={SEND}>Pay {usd(view.dueCents)}</button>}
    </div>
  </section>;
}
