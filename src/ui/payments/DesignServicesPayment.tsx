"use client";

import { CheckCircle2, LoaderCircle, Palette, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ServiceChargeView, ServicesPaymentView } from "@/payments/services-view";
import { money } from "../pricing/common";

type Body = { action: "checkout" | "charge" } | { action: "approve" | "cancel"; operationId: string };
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
 * client's one PayPal checkout for them, with PayPal or Pay Later. It shows on
 * that agreement's page: the quote while V1 stands (`orderId` null), otherwise
 * the latest confirmed version.
 */
export function DesignServicesPayment({ projectKey, orderId }: { projectKey: CaseKey; orderId: string | null }) {
  const [view, setView] = useState<ServicesPaymentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const checkout = useRef<string | null>(null);

  const load = useCallback(async () => {
    try { setView((await request(projectKey)).view); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The design-services payment could not be loaded."); }
  }, [projectKey]);
  useEffect(() => { void load(); }, [load]);

  async function run(label: string, body: Body, done?: (view: ServicesPaymentView) => string | null): Promise<Reply | null> {
    setBusy(label); setError(null); setNotice(null);
    try {
      const reply = await request(projectKey, body);
      setView(reply.view);
      setNotice(done?.(reply.view) ?? null);
      return reply;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The payment step did not finish. Reload to see what PayPal recorded.");
      void load();
      return null;
    } finally { setBusy(null); }
  }

  if (!view?.basis || view.basis.orderId !== orderId) return null;
  if (!view.services.length) {
    return <section id="design-services" className="mt-6 rounded-xl border border-dashed border-[var(--line)] p-4 text-[12px] text-[var(--muted)]"><strong className="font-medium text-[var(--ink)]">Design services · V{view.basis.version}. </strong>{view.reason}</section>;
  }
  const charged = view.dueCents === 0;
  const totalCents = view.services.reduce((total, line) => total + line.targetCents, 0);

  return <section id="design-services" aria-labelledby="design-services-title" className="mt-6 rounded-xl border border-[var(--line)] bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-50 text-violet-700"><Palette className="h-4 w-4" /></span>
      <div className="mr-auto"><h2 id="design-services-title" className="text-[13px] font-semibold">Design services · V{view.basis.version}</h2><p className="text-[11px] text-[var(--muted)]">Lee Studio&apos;s own services you approved, charged now in one PayPal checkout</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${charged ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{charged ? "Paid" : `${money(view.dueCents)} due`}</span>
    </div>
    <table className="mt-4 w-full border-collapse text-[12px]"><tbody>{view.services.map((line) => <ServiceRow key={line.itemId} line={line} />)}</tbody>
      <tfoot><tr className="border-t border-[var(--line)]"><td className="pt-2.5 font-medium">Design services total</td><td className="pt-2.5 text-right font-semibold tabular-nums">{money(totalCents)}</td><td /></tr></tfoot>
    </table>
    <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">PayPal holds the total once, then Setti captures each service separately, so each service keeps its own PayPal record. Furniture is not charged here: it is held later and captured only after the supplier confirms it.</p>

    {view.canPay && view.paypalClientId && <div className="mt-4 max-w-[360px]">
      <PayPalButtons clientId={view.paypalClientId} disabled={!!busy}
        createOrder={async () => {
          const reply = await run("checkout", { action: "checkout" });
          if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start.");
          checkout.current = reply.operationId;
          return reply.paypalOrderId;
        }}
        onApprove={async () => {
          if (!checkout.current) return;
          await run("approve", { action: "approve", operationId: checkout.current }, (next) => next.dueCents === 0 ? "Paid. Each design service was captured on PayPal." : next.canFinish ? "PayPal approved the payment. Some services are not captured yet; finish charging below." : null);
        }}
        onCancel={async () => {
          if (checkout.current) await run("cancel", { action: "cancel", operationId: checkout.current }, () => "You closed PayPal. Nothing was charged; you can pay again.");
        }}
        onError={() => { setError("PayPal could not finish the payment. Nothing is recorded as paid; try again or reload the page."); void load(); }}
      />
      {!view.savedPayPal && <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">Paying also saves PayPal for this project, which you approve on PayPal, so the studio can hold each approved item later without another checkout.</p>}
    </div>}
    {view.canFinish && <button type="button" disabled={!!busy} onClick={() => void run("charge", { action: "charge" }, (next) => next.dueCents === 0 ? "Paid. Each design service was captured on PayPal." : null)}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50">{busy === "charge" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Finish charging the design services</button>}
    {busy && busy !== "charge" && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />{busy === "approve" ? "Confirming with PayPal and capturing each service…" : "Working with PayPal…"}</p>}
    {view.reason && !view.canPay && !view.canFinish && <p className="mt-3 text-[11px] text-[var(--muted)]">{view.reason}</p>}
    {view.checkout?.failureMessage && !charged && <p className="mt-3 text-[11px] text-amber-800">{view.checkout.failureMessage}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
    {notice && <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">{notice}</p>}
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

interface PayPalButtonsInstance { isEligible(): boolean; render(container: HTMLElement): Promise<void>; close(): Promise<void> }
interface PayPalSdk {
  FUNDING: { PAYPAL: string; PAYLATER: string };
  Buttons(options: {
    fundingSource: string; style?: Record<string, string | number>;
    createOrder: () => Promise<string>; onApprove: () => Promise<void>; onCancel: () => Promise<void>; onError: (error: unknown) => void;
  }): PayPalButtonsInstance;
}
declare global { interface Window { settiPayPal?: PayPalSdk } }

const sdkLoads = new Map<string, Promise<PayPalSdk>>();

/** Loads the PayPal JS SDK once per client id, under its own namespace. */
function loadPayPal(clientId: string): Promise<PayPalSdk> {
  let load = sdkLoads.get(clientId);
  if (!load) {
    load = new Promise<PayPalSdk>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.paypal.com/sdk/js?${new URLSearchParams({ "client-id": clientId, currency: "USD", intent: "authorize", components: "buttons", "enable-funding": "paylater", "buyer-country": "US" })}`;
      // Probe P11: without a namespace the SDK's default global failed to start in Chrome.
      script.dataset.namespace = "settiPayPal";
      script.onload = () => window.settiPayPal ? resolve(window.settiPayPal) : reject(new Error("PayPal did not start."));
      script.onerror = () => { sdkLoads.delete(clientId); reject(new Error("PayPal could not be loaded.")); };
      document.head.appendChild(script);
    });
    sdkLoads.set(clientId, load);
  }
  return load;
}

/** PayPal's own PayPal and Pay Later buttons; each opens PayPal for the same checkout. */
function PayPalButtons(props: { clientId: string; disabled: boolean; createOrder: () => Promise<string>; onApprove: () => Promise<void>; onCancel: () => Promise<void>; onError: () => void }) {
  const paypal = useRef<HTMLDivElement>(null);
  const payLater = useRef<HTMLDivElement>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const { clientId } = props;

  useEffect(() => {
    let closed = false;
    const rendered: PayPalButtonsInstance[] = [];
    loadPayPal(clientId).then(async (sdk) => {
      for (const [fundingSource, container] of [[sdk.FUNDING.PAYPAL, paypal.current], [sdk.FUNDING.PAYLATER, payLater.current]] as const) {
        if (closed || !container) return;
        const buttons = sdk.Buttons({
          fundingSource, style: { layout: "vertical", height: 40, shape: "rect" },
          createOrder: () => handlers.current.createOrder(), onApprove: () => handlers.current.onApprove(),
          onCancel: () => handlers.current.onCancel(), onError: () => handlers.current.onError(),
        });
        if (!buttons.isEligible()) continue;
        rendered.push(buttons);
        await buttons.render(container);
      }
      if (!closed) setState("ready");
    }).catch(() => { if (!closed) setState("failed"); });
    return () => { closed = true; for (const buttons of rendered) void buttons.close().catch(() => undefined); };
  }, [clientId]);

  return <div aria-busy={state === "loading"} className={props.disabled ? "pointer-events-none opacity-50" : undefined}>
    {state === "loading" && <p className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Loading PayPal…</p>}
    {state === "failed" && <p role="alert" className="text-[11px] text-red-800">PayPal could not be loaded. Check the connection and reload the page.</p>}
    <div ref={paypal} />
    <div ref={payLater} className="mt-2" />
  </div>;
}
