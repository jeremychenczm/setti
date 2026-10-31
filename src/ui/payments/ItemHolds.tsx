"use client";

import { Armchair, ArrowUpRight, CheckCircle2, ChevronRight, CircleDollarSign, FilePenLine, LoaderCircle, LockKeyhole, RefreshCw, Truck, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ItemHoldView, ItemHoldsView } from "@/payments/item-holds-view";
import { centsText, dateTime, Field, inputClass, money, parseDollars } from "../pricing/common";
import { useTryReadiness } from "../try/useTryReadiness";
import type { CheckoutView } from "@/payments/types";
import { demoSupplierNumber } from "./demo-supplier";
import { PayMethodChooser, SavedMethodCard, savedMethodName } from "./PaymentMethods";
import { paymentChanged, usePaymentRefresh } from "./usePaymentRefresh";

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
  // The item whose card is open in the side drawer.
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [selected]);

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
  const open = view.items.find((line) => line.itemId === selected) ?? null;
  const confirm = (line: ItemHoldView, order: SupplierOrder) => run(`supplier:${line.itemId}`, { action: "supplier_order", itemId: line.itemId, contentHash, ...order, note: "" });
  /** The supplier confirmed other terms: the designer reprices the line in a new version that starts from them. */
  const revise = async (line: ItemHoldView, order: SupplierOrder) => {
    const supplier = { reference: order.reference, quantity: order.quantity, unitPriceCents: order.unitPriceCents, taxCents: order.taxCents, freightCents: order.freightCents, leadTimeDays: order.leadTimeDays };
    if (readiness.blocked) return;
    setBusy(`revise:${line.itemId}`); setError(null);
    try {
      const response = await fetch(`/api/pricing/${projectKey}/change-line`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: line.itemId, supplier }) });
      const json = await response.json().catch(() => null) as { href?: string; error?: string } | null;
      if (!response.ok || !json?.href) throw new Error(json?.error ?? `Request failed (${response.status}).`);
      window.location.assign(json.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The revised version could not start. Please retry.");
      setBusy(null);
    }
  };

  return <section id="item-holds" aria-labelledby="item-holds-title" className="mt-6 rounded-xl border border-[var(--line)] bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Armchair className="h-4 w-4" /></span>
      <div className="mr-auto"><h2 id="item-holds-title" className="text-[13px] font-semibold">Approved items · V{view.basis.version}</h2><p className="text-[11px] text-[var(--muted)]">Select an item to see its terms, PayPal hold and next step.</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${covered === view.items.length ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{covered} of {view.items.length} held</span>
    </div>
    {view.savedMethod && <div className="mt-3"><SavedMethodCard method={view.savedMethod} canRemove={view.canRemoveSaved} busy={busy === "remove"} disabled={!!busy || readiness.blocked} onRemove={() => void run("remove", { action: "remove_saved" })} /></div>}
    {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error}</p>}
    <div className="mt-3 max-h-[640px] overflow-auto rounded-lg border border-[var(--line)]">
      <table className="w-full min-w-[620px] border-collapse text-left text-[12px]">
        <thead className="sticky top-0 z-10 bg-[var(--canvas)] text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
          <tr><th className="px-3 py-2 font-medium">Item</th><th className="px-3 py-2 font-medium">Qty × price</th><th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 font-medium">Payment</th><th className="px-3 py-2 font-medium">Supplier order</th><th className="w-8" /></tr>
        </thead>
        <tbody>{view.items.map((line) => <tr key={line.itemId} onClick={() => setSelected(line.itemId)} aria-selected={selected === line.itemId}
          className={`cursor-pointer border-t border-[var(--line)] align-top transition-colors hover:bg-brand-50/60 ${selected === line.itemId ? "bg-brand-50" : ""}`}>
          <td className="px-3 py-2.5"><button type="button" onClick={() => setSelected(line.itemId)} className="text-left font-medium text-[var(--ink)] hover:underline">{line.label}</button>{line.vendor && <span className="block text-[10px] text-[var(--muted)]">{line.vendor}</span>}</td>
          <td className="px-3 py-2.5 tabular-nums text-slate-600">{line.terms ? `${line.terms.quantity} × ${money(line.terms.unitPriceCents)}` : "—"}</td>
          <td className="px-3 py-2.5 text-right tabular-nums">{money(line.targetCents)}</td>
          <td className="px-3 py-2.5 whitespace-nowrap text-[11px]"><ItemStatus line={line} /></td>
          <td className="px-3 py-2.5 text-[11px]">{line.supplier ? <span className="font-mono text-slate-700">{line.supplier.reference}</span> : <span className="text-[var(--muted)]">Not confirmed</span>}</td>
          <td className="pr-3 pt-3 text-[var(--muted)]"><ChevronRight className="h-3.5 w-3.5" /></td>
        </tr>)}</tbody>
      </table>
    </div>
    {view.canHold && view.toHoldCents > 0 && <button type="button" disabled={!!busy || readiness.blocked} onClick={() => void run("hold", { action: "hold" })}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 text-[12px] font-medium text-[var(--on-primary)] disabled:opacity-50">{busy === "hold" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LockKeyhole className="h-3.5 w-3.5" />}{failed ? "Retry the items that were not held" : `Hold ${money(view.toHoldCents)} with ${view.savedMethod ? savedMethodName(view.savedMethod) : "the saved method"}`}</button>}
    {busy === "hold" && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Holding each approved item on PayPal…</p>}
    {view.reason && !busy && <p className="mt-3 text-[11px] text-[var(--muted)]">{view.reason}</p>}
    {error && !open && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
    {open && <ItemDrawer key={open.itemId} line={open} designer={view.canConfirmSupplier} checkout={view.checkoutOptions} canHoldAll={view.canHold} busy={busy} blocked={readiness.blocked} error={error} send={send}
      onClose={() => setSelected(null)}
      onConfirm={(order) => void confirm(open, order)}
      onRevise={(order) => void revise(open, order)}
      onCapture={() => void run(`capture:${open.itemId}`, { action: "capture", itemId: open.itemId, contentHash })}
      onCheck={() => { if (open.operationId) void run(`check:${open.itemId}`, { action: "check", operationId: open.operationId }); }}
      onCancel={() => { if (open.operationId) void run(`cancel:${open.itemId}`, { action: "cancel", operationId: open.operationId }); }} />}
  </section>;
}

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

function ItemStatus({ line }: { line: ItemHoldView }) {
  return {
    captured: <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Captured</span>,
    confirmed: <span className="inline-flex items-center gap-1 text-emerald-700"><Truck className="h-3.5 w-3.5" />Ready to capture</span>,
    held: <span className="inline-flex items-center gap-1 text-brand-700"><LockKeyhole className="h-3.5 w-3.5" />Held{line.expiresAt ? ` · until ${shortDate(line.expiresAt)}` : ""}</span>,
    holding: <span className="inline-flex items-center gap-1 text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Holding</span>,
    awaiting_client: <span className="text-amber-800">Client approval needed</span>,
    unknown: <span className="text-amber-800">Outcome unknown · check PayPal</span>,
    failed: <span className="inline-flex items-center gap-1 text-amber-800"><TriangleAlert className="h-3.5 w-3.5" />Not held</span>,
    to_hold: <span className="text-[var(--muted)]">To hold</span>,
  }[line.state];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-baseline justify-between gap-3 py-1"><dt className="text-[var(--muted)]">{label}</dt><dd className="text-right tabular-nums text-[var(--ink)]">{children}</dd></div>;
}

/**
 * One item's card in a drawer beside the table: what the client approved, what
 * PayPal holds or captured, the supplier's confirmation, and the one next step,
 * which takes a single click (the demo supplier confirmation is filled in).
 */
type SupplierOrder = { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number; inStock: boolean; leadTimeDays: number | null; reference: string };

function ItemDrawer({ line, designer, checkout, canHoldAll, busy, blocked, error, send, onClose, onConfirm, onRevise, onCapture, onCheck, onCancel }: {
  line: ItemHoldView; designer: boolean; checkout: CheckoutView | null; canHoldAll: boolean; busy: string | null; blocked: boolean; error: string | null;
  send: (label: string, body: Body) => Promise<Reply | null>;
  onClose: () => void; onConfirm: (order: SupplierOrder) => void; onRevise: (order: SupplierOrder) => void; onCapture: () => void; onCheck: () => void; onCancel: () => void;
}) {
  const [save, setSave] = useState(true);
  // What the supplier confirmed: filled in from the approved line (there is no real supplier), and editable.
  const [reference, setReference] = useState(() => demoSupplierNumber("order", line.itemId));
  const [quantity, setQuantity] = useState(String(line.terms?.quantity ?? ""));
  const [unit, setUnit] = useState(centsText(line.terms?.unitPriceCents ?? null));
  const [tax, setTax] = useState(centsText(line.terms?.taxCents ?? null));
  const [delivery, setDelivery] = useState(centsText(line.terms?.freightCents ?? null));
  const [leadTime, setLeadTime] = useState(line.terms?.leadTimeDays != null ? String(line.terms.leadTimeDays) : "");
  const [inStock, setInStock] = useState(true);
  const popup = useRef<string | null>(null);
  const disabled = !!busy || blocked;
  const due = Math.max(line.targetCents - line.heldCents - line.capturedCents, 0);
  const terms = line.terms;
  const editing = designer && line.state === "held" && !!terms && !line.supplier;
  const amounts = [parseDollars(unit), parseDollars(tax), parseDollars(delivery)];
  const count = Number(quantity), days = leadTime.trim() ? Number(leadTime) : null;
  const problem = !reference.trim() ? "Enter the supplier's order number."
    : !Number.isSafeInteger(count) || count < 1 ? "Enter the quantity as a whole number."
      : amounts.some((amount) => amount.value === null) ? "Enter the unit price, tax and delivery in USD."
        : days !== null && (!Number.isSafeInteger(days) || days < 0) ? "Enter the lead time as whole days."
          : !inStock ? "Save it only once the supplier has the item and accepted the order." : null;
  const differs = !!terms && !problem && (count !== terms.quantity || amounts[0].value !== terms.unitPriceCents || amounts[1].value !== terms.taxCents || amounts[2].value !== terms.freightCents);
  const primary = "inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2.5 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50";
  const note = "mt-2 text-center text-[11px] leading-relaxed text-[var(--muted)]";

  const order = (): SupplierOrder => ({ quantity: count, unitPriceCents: amounts[0].value!, taxCents: amounts[1].value!, freightCents: amounts[2].value!, inStock, leadTimeDays: days, reference: reference.trim() });

  let next: React.ReactNode = null;
  // Terms that differ cannot be saved against the approved version: the client confirms them in a new one first.
  if (editing && differs) next = <>
    <button type="button" disabled={disabled} onClick={() => onRevise(order())} className={primary}>{busy === `revise:${line.itemId}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FilePenLine className="h-4 w-4" />}Start a revised version</button>
    <p className={note}>Opens the pricing page with the supplier&apos;s terms filled in. You check and send it; the client confirms it before any money moves.</p>
  </>;
  else if (editing) next = <>
    <button type="button" disabled={disabled || !!problem} onClick={() => onConfirm(order())} className={primary}>{busy === `supplier:${line.itemId}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}Save supplier confirmation</button>
    <p className={note}>Capture becomes available once it is saved.</p>
  </>;
  else if (line.state === "held") next = <p className={note}>Held on PayPal. The studio captures it after the supplier confirms the order.</p>;
  else if (line.state === "confirmed" && designer) next = <>
    <button type="button" disabled={disabled} onClick={onCapture} className={primary}>{busy === `capture:${line.itemId}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />}Capture {money(line.heldCents)}</button>
    <p className={note}>Takes the confirmed amount from the PayPal hold and closes it.</p>
  </>;
  else if (line.state === "confirmed") next = <p className={note}>The supplier confirmed the order. The studio captures the held amount next.</p>;
  else if (line.state === "captured") next = <p className={note}>Captured on PayPal. Nothing more is due for this item.</p>;
  else if (line.canCheckout && checkout) next = <PayMethodChooser options={checkout} disabled={disabled} testCardBusy={busy === `test_card:${line.itemId}`} save={save} onSaveChange={setSave}
    onTestCard={() => void send(`test_card:${line.itemId}`, { action: "checkout", itemId: line.itemId, via: "test_card", save })}
    paypal={{
      createOrder: async () => {
        const reply = await send(`checkout:${line.itemId}`, { action: "checkout", itemId: line.itemId, via: "popup", save });
        if (!reply?.paypalOrderId || !reply.operationId) throw new Error("The PayPal checkout could not start.");
        popup.current = reply.operationId;
        return reply.paypalOrderId;
      },
      onApprove: async () => { if (popup.current) await send(`check:${line.itemId}`, { action: "check", operationId: popup.current }); },
      onCancel: async () => { if (popup.current) await send(`cancel:${line.itemId}`, { action: "cancel", operationId: popup.current }); },
      onError: () => { if (popup.current) void send(`check:${line.itemId}`, { action: "check", operationId: popup.current }); },
    }} />;
  else if ((line.state === "to_hold" || line.state === "failed") && canHoldAll) next = <p className={note}>Hold it with the saved payment method using the Hold button under the table.</p>;

  return <>
    {/* A click beside the drawer closes it. PayPal's own popup overlay sits above this, so it never closes a checkout. */}
    <div aria-hidden className="fixed inset-0 z-30" onClick={onClose} />
    <aside role="dialog" aria-labelledby="item-drawer-title" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-[var(--line)] bg-white shadow-2xl">
    <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
      <div className="min-w-0 flex-1">
        <h3 id="item-drawer-title" className="text-[15px] font-semibold leading-snug">{line.label}</h3>
        {line.vendor && <p className="mt-0.5 text-[11px] text-[var(--muted)]">{line.vendor}</p>}
        <p className="mt-2 inline-flex rounded-full bg-[var(--canvas)] px-2.5 py-1 text-[11px]"><ItemStatus line={line} /></p>
      </div>
      <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
    </header>
    <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[12px]">
      <section aria-label="Approved terms">
        <h4 className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Approved by the client</h4>
        <dl className="mt-1.5 divide-y divide-[var(--line)]">
          {terms && <Row label="Quantity × unit price">{terms.quantity} × {money(terms.unitPriceCents)}</Row>}
          {terms && <Row label="Tax · delivery">{money(terms.taxCents)} · {money(terms.freightCents)}</Row>}
          {terms?.leadTimeDays != null && <Row label="Lead time">{terms.leadTimeDays} days</Row>}
          <Row label="Total"><span className="font-semibold">{money(line.targetCents)}</span></Row>
        </dl>
      </section>
      <section aria-label="PayPal">
        <h4 className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">PayPal · Sandbox</h4>
        <dl className="mt-1.5 divide-y divide-[var(--line)]">
          <Row label="Held">{money(line.heldCents)}</Row>
          {line.expiresAt && <Row label="Hold expires">{dateTime(line.expiresAt)}</Row>}
          <Row label="Captured">{money(line.capturedCents)}</Row>
          {due > 0 && <Row label="Still to hold">{money(due)}</Row>}
          {line.paypalAuthorizationId && <Row label="Authorization"><span className="font-mono text-[11px]">{line.paypalAuthorizationId}</span></Row>}
        </dl>
        {line.failureMessage && <p className="mt-2 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900">{line.failureMessage}</p>}
        {(line.canCheck || line.approvalUrl || line.canCancel) && <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
          {line.approvalUrl && !blocked && <a href={line.approvalUrl} className="inline-flex items-center gap-1 font-medium text-brand-700 underline">Continue on PayPal<ArrowUpRight className="h-3 w-3" /></a>}
          {line.canCheck && <button type="button" disabled={disabled} onClick={onCheck} className="inline-flex items-center gap-1 font-medium underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Check PayPal status</button>}
          {line.canCancel && <button type="button" disabled={disabled} onClick={onCancel} className="underline disabled:opacity-50">Leave checkout</button>}
        </div>}
      </section>
      {terms && <section aria-label="Supplier confirmation">
        <h4 className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Supplier confirmation{line.supplier ? "" : " · demo"}</h4>
        {editing ? <div className="mt-2 space-y-2.5">
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">There is no real supplier in this demo, so this is filled in from the approved line. Change anything the supplier confirmed differently.</p>
          <Field label="Supplier's order number"><input className={inputClass} value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} placeholder="From the supplier's order confirmation" /></Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Quantity"><input className={inputClass} inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
            <Field label="Unit price · USD"><input className={inputClass} inputMode="decimal" value={unit} onChange={(event) => setUnit(event.target.value)} /></Field>
            <Field label="Tax · USD"><input className={inputClass} inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></Field>
            <Field label="Delivery · USD"><input className={inputClass} inputMode="decimal" value={delivery} onChange={(event) => setDelivery(event.target.value)} /></Field>
            <Field label="Lead time · days"><input className={inputClass} inputMode="numeric" value={leadTime} onChange={(event) => setLeadTime(event.target.value)} placeholder="Optional" /></Field>
          </div>
          <label className="flex items-start gap-2 text-[11px] text-slate-600"><input type="checkbox" checked={inStock} onChange={(event) => setInStock(event.target.checked)} className="mt-0.5 accent-[var(--primary)]" />The supplier has the item and accepted the order.</label>
          {problem && <p role="alert" className="text-[11px] text-red-700">{problem}</p>}
          {differs && <p role="status" className="rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900">This differs from what the client approved ({terms.quantity} × {money(terms.unitPriceCents)}, tax {money(terms.taxCents)}, delivery {money(terms.freightCents)}), so it cannot be saved against V1. Start a revised version with these terms for the client to confirm.</p>}
        </div> : <dl className="mt-1.5 divide-y divide-[var(--line)]">
          <Row label="Supplier's order number"><span className="font-mono text-[11px]">{line.supplier?.reference ?? "Not saved yet"}</span></Row>
          <Row label="Confirmed">{line.supplier ? `${money(line.supplier.totalCents)}${line.supplier.leadTimeDays != null ? ` · ${line.supplier.leadTimeDays} days` : ""}` : "Not yet"}</Row>
        </dl>}
      </section>}
    </div>
    {(next || error) && <footer className="border-t border-[var(--line)] px-5 py-4">
      {error && <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-800">{error}</p>}
      {next}
    </footer>}
  </aside>
  </>;
}
