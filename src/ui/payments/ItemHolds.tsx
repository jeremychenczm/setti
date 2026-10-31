"use client";

import { Armchair, ArrowUpRight, CheckCircle2, CircleDollarSign, LoaderCircle, LockKeyhole, RefreshCw, Truck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ItemHoldView, ItemHoldsView } from "@/payments/item-holds-view";
import { centsText, dateTime, Field, inputClass, money, parseDollars } from "../pricing/common";
import { useTryReadiness } from "../try/useTryReadiness";
import type { CheckoutView } from "@/payments/types";
import { PayMethodChooser, SavedMethodCard, savedMethodName } from "./PaymentMethods";
import { paymentChanged, usePaymentRefresh } from "./usePaymentRefresh";

type Terms = NonNullable<ItemHoldView["terms"]>;
type Body =
  | { action: "hold" | "remove_saved" }
  | { action: "check" | "cancel"; operationId: string }
  | { action: "checkout"; itemId: string; via: "popup" | "test_card"; save: boolean }
  | { action: "capture"; itemId: string; contentHash: string }
  | { action: "supplier_order"; itemId: string; contentHash: string; quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean; leadTimeDays: number | null; reference: string; note: string };

type Reply = { view: ItemHoldsView; operationId: string | null; paypalOrderId: string | null };

async function request(key: CaseKey, body?: Body): Promise<Reply> {
  const response = await fetch(`/api/quotes/${key}/item-holds`, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  return body ? json as Reply : { view: json as ItemHoldsView, operationId: null, paypalOrderId: null };
}

/**
 * The approved furniture of the project's current agreement, each with its own
 * PayPal hold placed with the client's saved payment method. The button explicitly
 * starts the holds and also retries items whose hold failed. On V1 the designer
 * records each supplier's confirmation here and then captures the item.
 */
export function ItemHolds({ projectKey, orderId }: { projectKey: CaseKey; orderId: string | null }) {
  const readiness = useTryReadiness(projectKey);
  const [view, setView] = useState<ItemHoldsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setView((await request(projectKey)).view); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The item holds could not be loaded."); }
  }, [projectKey]);
  usePaymentRefresh(projectKey, load);
  useEffect(() => { void load(); }, [load, readiness.blocked]);

  /** Runs one step; returns the server's reply, or null when it did not start or failed. */
  const send = useCallback(async (label: string, body: Body): Promise<Reply | null> => {
    if (readiness.blocked) return null;
    setBusy(label); setError(null);
    try { const reply = await request(projectKey, body); setView(reply.view); return reply; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The step did not finish. Reload to see what PayPal recorded."); void load(); return null; }
    finally { setBusy(null); paymentChanged(projectKey); }
  }, [projectKey, load, readiness.blocked]);
  const run = useCallback(async (label: string, body: Body) => !!await send(label, body), [send]);

  if (!view?.basis || view.basis.orderId !== orderId || !view.items.length) return null;
  const covered = view.items.filter((line) => line.state === "held" || line.state === "confirmed" || line.state === "captured").length;
  const failed = view.items.filter((line) => line.state === "failed").length;
  const contentHash = view.contentHash ?? "";

  return <section id="item-holds" aria-labelledby="item-holds-title" className="mt-6 rounded-xl border border-[var(--line)] bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Armchair className="h-4 w-4" /></span>
      <div className="mr-auto"><h2 id="item-holds-title" className="text-[13px] font-semibold">Approved items · V{view.basis.version}</h2><p className="text-[11px] text-[var(--muted)]">{view.savedMethod ? "Each item gets its own hold with the saved payment method. If PayPal needs the client, the same order continues on PayPal." : "Each item gets its own PayPal hold, paid with PayPal or a card."}</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${covered === view.items.length ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{covered} of {view.items.length} held</span>
    </div>
    <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">A hold reserves the item&apos;s amount on the client&apos;s payment method. Nothing is charged until the supplier confirms the item on the approved terms; a hold lasts up to 29 days.</p>
    {view.savedMethod && <div className="mt-3"><SavedMethodCard method={view.savedMethod} canRemove={view.canRemoveSaved} busy={busy === "remove"} disabled={!!busy || readiness.blocked} onRemove={() => void run("remove", { action: "remove_saved" })} /></div>}
    {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error}</p>}
    <div className="mt-3 max-h-[640px] overflow-y-auto"><table className="w-full border-collapse text-[12px]"><tbody>{view.items.map((line) => <ItemRow key={line.itemId} line={line}
      designer={view.canConfirmSupplier} busy={busy} blocked={readiness.blocked} open={confirming === line.itemId} checkout={view.checkoutOptions} send={send}
      onCheck={() => { if (line.operationId) void run(`check:${line.itemId}`, { action: "check", operationId: line.operationId }); }}
      onCancel={() => { if (line.operationId) void run(`cancel:${line.itemId}`, { action: "cancel", operationId: line.operationId }); }}
      onConfirm={() => setConfirming(confirming === line.itemId ? null : line.itemId)}
      onRecord={async (order) => { if (await run(`supplier:${line.itemId}`, { action: "supplier_order", itemId: line.itemId, contentHash, ...order })) setConfirming(null); }}
      onCapture={() => void run(`capture:${line.itemId}`, { action: "capture", itemId: line.itemId, contentHash })} />)}</tbody></table></div>
    {view.canHold && view.toHoldCents > 0 && <button type="button" disabled={!!busy || readiness.blocked} onClick={() => void run("hold", { action: "hold" })}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 text-[12px] font-medium text-[var(--on-primary)] disabled:opacity-50">{busy === "hold" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LockKeyhole className="h-3.5 w-3.5" />}{failed ? "Retry the items that were not held" : `Hold ${money(view.toHoldCents)} with ${view.savedMethod ? savedMethodName(view.savedMethod) : "the saved method"}`}</button>}
    {busy === "hold" && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Holding each approved item on PayPal…</p>}
    {view.reason && !busy && <p className="mt-3 text-[11px] text-[var(--muted)]">{view.reason}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
  </section>;
}

function ItemRow({ line, designer, busy, blocked, open, checkout, send, onConfirm, onRecord, onCapture, onCheck, onCancel }: {
  line: ItemHoldView; designer: boolean; busy: string | null; blocked: boolean; open: boolean;
  checkout: CheckoutView | null; send: (label: string, body: Body) => Promise<Reply | null>;
  onConfirm: () => void; onRecord: (order: SupplierOrder) => Promise<void>; onCapture: () => void;
  onCheck: () => void; onCancel: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [save, setSave] = useState(true);
  const popup = useRef<string | null>(null);
  const paying = line.canCheckout && !!checkout;
  const status = {
    captured: <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Captured</span>,
    confirmed: <span className="inline-flex items-center gap-1 text-emerald-700"><Truck className="h-3.5 w-3.5" />Supplier confirmed · {line.supplier?.reference}</span>,
    held: <span className="inline-flex items-center gap-1 text-brand-700"><LockKeyhole className="h-3.5 w-3.5" />Held{line.expiresAt ? ` · until ${dateTime(line.expiresAt)}` : ""}</span>,
    holding: <span className="inline-flex items-center gap-1 text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Holding</span>,
    awaiting_client: <span className="text-amber-800">Client approval needed</span>,
    unknown: <span className="text-amber-800">Outcome unknown · check PayPal</span>,
    failed: <span className="inline-flex items-center gap-1 text-amber-800" title={line.failureMessage ?? undefined}><TriangleAlert className="h-3.5 w-3.5" />Not held</span>,
    to_hold: <span className="text-[var(--muted)]">To hold</span>,
  }[line.state];
  const action = designer && line.state === "held" && line.terms
    ? <button type="button" disabled={!!busy || blocked} onClick={onConfirm} className="ml-2 rounded-md border border-[var(--line)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--canvas)] disabled:opacity-50">{open ? "Close" : "Supplier confirmed…"}</button>
    : designer && line.state === "confirmed"
      ? <button type="button" disabled={!!busy || blocked} onClick={onCapture} className="ml-2 inline-flex items-center gap-1 rounded-md bg-[var(--primary-fill)] px-2 py-1 text-[11px] font-medium text-[var(--on-primary)] disabled:opacity-50">{busy === `capture:${line.itemId}` ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <CircleDollarSign className="h-3 w-3" />}Capture {money(line.heldCents)}</button>
      : paying
        ? <button type="button" disabled={!!busy || blocked} onClick={() => setChoosing(!choosing)} className="ml-2 inline-flex items-center gap-1 rounded-md bg-[var(--primary-fill)] px-2 py-1 text-[11px] font-medium text-[var(--on-primary)] disabled:opacity-50"><LockKeyhole className="h-3 w-3" />{choosing ? "Close" : `Hold ${money(line.targetCents - line.heldCents - line.capturedCents)}`}</button>
        : null;
  return <>
    <tr className="border-t border-[var(--line)] first:border-t-0">
      <td className="py-2 pr-3">{line.label}{line.failureMessage && <p className="mt-0.5 text-[10px] text-amber-800">{line.failureMessage}</p>}
        {(line.canCheck || line.approvalUrl) && <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
          {line.approvalUrl && !blocked && <a href={line.approvalUrl} className="inline-flex items-center gap-1 font-medium text-brand-700 underline">Continue on PayPal<ArrowUpRight className="h-3 w-3" /></a>}
          {line.canCheck && <button type="button" disabled={!!busy || blocked} onClick={onCheck} className="inline-flex items-center gap-1 font-medium underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Check PayPal status</button>}
          {line.canCancel && <button type="button" disabled={!!busy || blocked} onClick={onCancel} className="underline disabled:opacity-50">Leave checkout</button>}
        </div>}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{money(line.targetCents)}</td>
      <td className="py-2 text-right text-[11px] whitespace-nowrap">{status}{action}</td>
    </tr>
    {open && line.terms && <tr><td colSpan={3} className="pb-3"><SupplierForm terms={line.terms} busy={blocked || busy === `supplier:${line.itemId}`} onRecord={onRecord} /></td></tr>}
    {paying && choosing && <tr><td colSpan={3} className="pb-3"><div className="rounded-lg bg-[var(--canvas)] p-3">
      <p className="mb-3 text-[11px] leading-relaxed text-slate-600">Hold {money(line.targetCents - line.heldCents - line.capturedCents)} for {line.label}. PayPal opens in a window over this page; nothing is charged until the supplier confirms.</p>
      <PayMethodChooser options={checkout!} disabled={!!busy || blocked} testCardBusy={busy === `test_card:${line.itemId}`} save={save} onSaveChange={setSave}
        onTestCard={() => void send(`test_card:${line.itemId}`, { action: "checkout", itemId: line.itemId, via: "test_card", save }).then((reply) => { if (reply) setChoosing(false); })}
        paypal={{
          createOrder: async () => {
            const reply = await send(`checkout:${line.itemId}`, { action: "checkout", itemId: line.itemId, via: "popup", save });
            if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start.");
            popup.current = reply.operationId;
            return reply.paypalOrderId;
          },
          onApprove: async () => { if (popup.current) { await send(`check:${line.itemId}`, { action: "check", operationId: popup.current }); setChoosing(false); } },
          onCancel: async () => { if (popup.current) await send(`cancel:${line.itemId}`, { action: "cancel", operationId: popup.current }); },
          onError: () => { if (popup.current) void send(`check:${line.itemId}`, { action: "check", operationId: popup.current }); },
        }} />
    </div></td></tr>}
  </>;
}

type SupplierOrder = { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean; leadTimeDays: number | null; reference: string; note: string };

/** The supplier's confirmation as the designer enters it (demo), prefilled with the approved terms it must match. */
function SupplierForm({ terms, busy, onRecord }: { terms: Terms; busy: boolean; onRecord: (order: SupplierOrder) => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(terms.quantity));
  const [unit, setUnit] = useState(centsText(terms.unitPriceCents));
  const [tax, setTax] = useState(centsText(terms.taxCents));
  const [delivery, setDelivery] = useState(centsText(terms.freightCents));
  const [inStock, setInStock] = useState(true);
  const [leadTime, setLeadTime] = useState("");
  const [reference, setReference] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    const amounts = [parseDollars(unit), parseDollars(tax), parseDollars(delivery)];
    const count = Number(quantity), days = leadTime.trim() ? Number(leadTime) : null;
    if (!Number.isSafeInteger(count) || count < 1) return setProblem("Enter the confirmed quantity as a whole number.");
    if (amounts.some((amount) => amount.error || amount.value === null)) return setProblem("Enter the unit price, tax and delivery in USD.");
    if (days !== null && (!Number.isSafeInteger(days) || days < 0)) return setProblem("Enter the lead time as whole days.");
    if (!reference.trim()) return setProblem("Enter the supplier's confirmation reference.");
    setProblem(null);
    void onRecord({ quantity: count, unitPriceCents: amounts[0].value!, taxCents: amounts[1].value!, freightCents: amounts[2].value!, inStock, leadTimeDays: days, reference: reference.trim(), note: "" });
  }

  return <div className="rounded-lg bg-[var(--canvas)] p-3">
    <p className="mb-2 text-[11px] leading-relaxed text-[var(--muted)]">Demo: enter what the supplier confirmed. It must match the approved line ({terms.quantity} × {money(terms.unitPriceCents)}, tax {money(terms.taxCents)}, delivery {money(terms.freightCents)}); any difference needs a new version for the client, and nothing is captured.</p>
    <div className="grid gap-2 sm:grid-cols-4">
      <Field label="Quantity"><input className={inputClass} inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
      <Field label="Unit price (USD)"><input className={inputClass} inputMode="decimal" value={unit} onChange={(event) => setUnit(event.target.value)} /></Field>
      <Field label="Tax (USD)"><input className={inputClass} inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></Field>
      <Field label="Delivery (USD)"><input className={inputClass} inputMode="decimal" value={delivery} onChange={(event) => setDelivery(event.target.value)} /></Field>
      <Field label="Confirmation reference"><input className={inputClass} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="e.g. SO-10482" /></Field>
      <Field label="Lead time (days)"><input className={inputClass} inputMode="numeric" value={leadTime} onChange={(event) => setLeadTime(event.target.value)} /></Field>
      <label className="flex items-end gap-2 pb-2 text-[11px] text-slate-600"><input type="checkbox" checked={inStock} onChange={(event) => setInStock(event.target.checked)} />In stock</label>
      <div className="flex items-end"><button type="button" disabled={busy} onClick={submit} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 text-[12px] font-medium text-[var(--on-primary)] disabled:opacity-50">{busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Record confirmation</button></div>
    </div>
    {problem && <p role="alert" className="mt-2 text-[11px] text-red-700">{problem}</p>}
  </div>;
}
