"use client";

import { CheckCircle2, LoaderCircle, Palette, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ServiceChargeView, ServicesPaymentView } from "@/payments/services-view";
import { money } from "../pricing/common";
import { useTryReadiness } from "../try/useTryReadiness";
import { PayMethodChooser, SavedMethodCard } from "./PaymentMethods";
import { paymentChanged, usePaymentRefresh } from "./usePaymentRefresh";

type Body = { action: "checkout" | "test_card"; save: boolean } | { action: "charge" | "remove_saved" } | { action: "approve" | "cancel" | "check"; operationId: string };
interface Reply { view: ServicesPaymentView; operationId: string | null; paypalOrderId: string | null }

async function request(key: CaseKey, body?: Body): Promise<Reply> {
  const response = await fetch(`/api/quotes/${key}/services-payment`, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  return body ? json as Reply : { view: json as ServicesPaymentView, operationId: null, paypalOrderId: null };
}

/**
 * The approved design services of the project's current agreement and the
 * client's one payment for them: PayPal or Pay Later in a window over the page,
 * or the Sandbox test card. It shows on
 * that agreement's page: the quote while V1 stands (`orderId` null), otherwise
 * the latest confirmed version. `onPaid` runs shortly after a payment on this
 * page settles the services in full.
 */
export function DesignServicesPayment({ projectKey, orderId, onPaid }: { projectKey: CaseKey; orderId: string | null; onPaid?: () => void }) {
  const readiness = useTryReadiness(projectKey);
  const [view, setView] = useState<ServicesPaymentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [save, setSave] = useState(true);
  const checkout = useRef<string | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (leaving.current) clearTimeout(leaving.current); }, []);

  const load = useCallback(async () => {
    try { setView((await request(projectKey)).view); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The design-services payment could not be loaded."); }
  }, [projectKey]);
  usePaymentRefresh(projectKey, load);
  useEffect(() => { void load(); }, [load, readiness.blocked]);

  async function run(label: string, body: Body, done?: (view: ServicesPaymentView) => string | null): Promise<Reply | null> {
    if (readiness.blocked) return null;
    setBusy(label); setError(null); setNotice(null);
    const wasDue = (view?.dueCents ?? 0) > 0;
    try {
      const reply = await request(projectKey, body);
      setView(reply.view);
      // Paying the services is the client's last step before the designer's turn: the chat shows the hand-off.
      const handOff = onPaid && wasDue && reply.view.dueCents === 0;
      setNotice([done?.(reply.view), handOff ? "Opening the project chat…" : null].filter(Boolean).join(" ") || null);
      if (handOff) leaving.current = setTimeout(onPaid, 1500);
      return reply;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment step did not finish. Reload to see what PayPal recorded.");
      void load();
      return null;
    } finally { setBusy(null); paymentChanged(projectKey); }
  }

  if (!view?.basis || view.basis.orderId !== orderId) return null;
  if (!view.services.length) {
    return <section id="design-services" className="mt-6 rounded-xl border border-dashed border-[var(--line)] p-4 text-[12px] text-[var(--muted)]"><strong className="font-medium text-[var(--ink)]">Design services · V{view.basis.version}. </strong>{view.reason}</section>;
  }
  const charged = view.dueCents === 0;
  const totalCents = view.services.reduce((total, line) => total + line.targetCents, 0);
  const furniture = view.furnitureToHold;
  /** Paying holds the furniture only with a saved method: the one already saved, or the one this payment saves. */
  const holdsFurniture = furniture.count > 0 && (!!view.savedMethod || save);

  const paying = view.canPay && !!view.checkoutOptions && !readiness.blocked;
  const status = <>
    {busy && busy !== "charge" && busy !== "check" && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />{busy === "approve" || busy === "test_card" ? `Confirming with PayPal and capturing each service${holdsFurniture ? ", then holding each furniture item. This can take a little while" : ""}…` : busy === "remove" ? "Asking PayPal to delete the saved payment method…" : "Working with PayPal…"}</p>}
    {view.reason && !view.canPay && !view.canFinish && <p className="mt-3 text-[11px] text-[var(--muted)]">{view.reason}</p>}
    {view.checkout?.failureMessage && !charged && <p className="mt-3 text-[11px] text-amber-800">{view.checkout.failureMessage}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">{notice}</p>}
  </>;

  return <section id="design-services" aria-labelledby="design-services-title" className="mt-6 rounded-xl border border-[var(--line)] bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-50 text-violet-700"><Palette className="h-4 w-4" /></span>
      <div className="mr-auto"><h2 id="design-services-title" className="text-[13px] font-semibold">Design services · V{view.basis.version}</h2><p className="text-[11px] text-[var(--muted)]">{charged ? 'Already paid · no additional design fee is due for this version' : "Lee Studio’s approved services, paid once with PayPal or a card"}</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${charged ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{charged ? "Paid" : `${money(view.dueCents)} due`}</span>
    </div>
    {/* Paying looks like a checkout: what is being paid on the left, how to pay on the right. */}
    <div className={paying ? "mt-4 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" : "mt-4"}>
      <div className="min-w-0">
        <table className="w-full border-collapse text-[12px]"><tbody>{view.services.map((line) => <ServiceRow key={line.itemId} line={line} />)}</tbody>
          <tfoot><tr className="border-t border-[var(--line)]"><td className="pt-2.5 font-medium">Design services total</td><td className="pt-2.5 text-right font-semibold tabular-nums">{money(totalCents)}</td><td /></tr></tfoot>
        </table>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">PayPal holds the services total once, then Setti captures each service separately, so each service keeps its own PayPal record.</p>
      </div>
      {paying && view.checkoutOptions && <aside aria-label="Pay the design services" className="rounded-xl bg-[var(--canvas)] p-4">
        <h3 className="text-[12px] font-semibold">This payment</h3>
        <div aria-label="What this payment does" className="mt-2.5 space-y-1.5 text-[12px]">
          <div className="flex justify-between gap-3"><span>Design services · charged now</span><span className="font-semibold tabular-nums">{money(view.dueCents)}</span></div>
          {furniture.count > 0 && <div className="flex justify-between gap-3"><span>Furniture · {furniture.count} {furniture.count === 1 ? "item" : "items"} {holdsFurniture ? "held now" : "held later"}</span><span className="tabular-nums">{money(furniture.cents)}</span></div>}
        </div>
        {furniture.count > 0 && <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{holdsFurniture
          ? "Held on the same payment method, one PayPal authorization per item. Nothing is charged for an item until its supplier confirms it."
          : "Without a saved payment method, you hold each furniture item yourself later."}</p>}
        <div className="mt-3.5 border-t border-[var(--line)] pt-3.5">
          <PayMethodChooser options={view.checkoutOptions} disabled={!!busy || readiness.blocked} testCardBusy={busy === "test_card"} save={save} onSaveChange={setSave}
            onTestCard={() => void run("test_card", { action: "test_card", save }, (next) => next.dueCents === 0 ? "Paid with the Sandbox test card. Each design service was captured on PayPal." : next.canFinish ? "PayPal approved the test card. Finish charging the services below." : null)}
            paypal={{
              createOrder: async () => {
                const reply = await run("checkout", { action: "checkout", save });
                if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start.");
                checkout.current = reply.operationId;
                return reply.paypalOrderId;
              },
              onApprove: async () => {
                if (!checkout.current) return;
                await run("approve", { action: "approve", operationId: checkout.current }, (next) => next.dueCents === 0 ? "Paid. Each design service was captured on PayPal." : next.canFinish ? "PayPal approved the payment. Some services are not captured yet; finish charging below." : null);
              },
              onCancel: async () => {
                if (checkout.current) await run("cancel", { action: "cancel", operationId: checkout.current }, (next) => next.dueCents === 0 ? "PayPal confirmed the payment. Each service was captured." : next.canFinish ? "PayPal confirmed the hold. Finish charging the services below." : "You closed PayPal. Check this same checkout or continue it before starting another payment.");
              },
              onError: () => { setError("PayPal could not finish the payment. Nothing is recorded as paid; try again or reload the page."); void load(); },
            }}
          />
        </div>
        {status}
      </aside>}
    </div>
    {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error}</p>}

    {view.savedMethod && <div className="mt-4"><SavedMethodCard method={view.savedMethod} canRemove={view.canRemoveSaved} busy={busy === "remove"} disabled={!!busy || readiness.blocked}
      onRemove={() => void run("remove", { action: "remove_saved" }, () => "Removed. PayPal deleted the saved payment method; later holds ask for PayPal or a card again.")} /></div>}
    {view.canCheck && view.checkout && <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" disabled={!!busy || readiness.blocked} onClick={() => void run("check", { action: "check", operationId: view.checkout!.operationId }, (next) => next.dueCents === 0 ? "Paid. The original PayPal checkout was recovered and each service was captured." : next.canFinish ? "PayPal confirmed the hold. Finish charging the services below." : next.canPay ? "The original checkout is ready. Continue on PayPal to approve it." : "PayPal has not confirmed the outcome yet. Check this same checkout again.")}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-2 text-[12px] font-medium disabled:opacity-50">{busy === "check" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check PayPal status</button>
      {view.checkout.approvalUrl && !busy && !readiness.blocked && <a href={view.checkout.approvalUrl} className="text-[12px] font-medium text-[var(--primary)] underline">Continue on PayPal</a>}
    </div>}
    {view.canFinish && <button type="button" disabled={!!busy || readiness.blocked} onClick={() => void run("charge", { action: "charge" }, (next) => next.dueCents === 0 ? "Paid. Each design service was captured on PayPal." : null)}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 text-[12px] font-medium text-[var(--on-primary)] disabled:opacity-50">{busy === "charge" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Finish charging the design services</button>}
    {!paying && status}
  </section>;
}

function ServiceRow({ line }: { line: ServiceChargeView }) {
  const paid = line.capturedCents >= line.targetCents;
  const fees = line.captures.filter((capture) => capture.status === "completed").map((capture) => capture.settlement.feeCents);
  const fee = fees.length && fees.every((value) => value !== null) ? fees.reduce<number>((total, value) => total + value!, 0) : null;
  return <tr className="border-t border-[var(--line)] first:border-t-0">
    <td className="py-2 pr-3">{line.label}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{money(line.targetCents)}</td>
    <td className="w-[190px] py-2 text-right text-[11px]">{paid
      ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Captured{fee !== null ? ` · PayPal fee ${money(fee)}` : ""}</span>
      : line.capturedCents > 0 ? <span className="text-amber-800">{money(line.capturedCents)} captured</span> : <span className="text-[var(--muted)]">To pay</span>}</td>
  </tr>;
}
