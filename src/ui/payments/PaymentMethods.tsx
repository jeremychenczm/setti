"use client";

import { Check, Copy, CreditCard, LoaderCircle, Wallet } from "lucide-react";
import { useState } from "react";
import type { SavedMethodView } from "@/payments/saved-methods";
import type { CheckoutView } from "@/payments/types";
import { PayPalButtons, type PayPalHandlers } from "./PayPalButtons";

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

/** How the client sees a saved method: a card by brand and last digits, PayPal by a masked email. */
export function savedMethodName(method: SavedMethodView): string {
  return method.kind === "card" ? method.label : `PayPal · ${method.label}`;
}

/**
 * The payment method saved for this project. The client may remove it: PayPal
 * deletes it first, and later holds then go through PayPal or a card again.
 */
export function SavedMethodCard({ method, canRemove, busy, disabled, onRemove }: { method: SavedMethodView; canRemove: boolean; busy: boolean; disabled: boolean; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const Icon = method.kind === "card" ? CreditCard : Wallet;
  return <div className="rounded-xl border border-[var(--line)] bg-[var(--canvas)] px-3.5 py-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[var(--ink)] shadow-sm"><Icon className="h-4 w-4" /></span>
      <div className="mr-auto min-w-0">
        <p className="text-[13px] font-semibold">{savedMethodName(method)}</p>
        <p className="text-[11px] text-[var(--muted)]">Saved for this project on {shortDate(method.savedAt)} · later holds need no PayPal window</p>
      </div>
      {canRemove && !confirming && <button type="button" disabled={disabled} onClick={() => setConfirming(true)} className="text-[11px] font-medium text-[var(--muted)] underline hover:text-[var(--ink)] disabled:opacity-50">Remove</button>}
    </div>
    {canRemove && confirming && <div role="group" aria-label="Confirm removal" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-white p-2.5 text-[11px] leading-relaxed text-slate-700">
      <span className="min-w-[200px] flex-1">Remove it from this project? PayPal deletes it; holds already placed stay as they are.</span>
      <button type="button" disabled={disabled} onClick={() => { onRemove(); setConfirming(false); }} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white disabled:opacity-50">{busy && <LoaderCircle className="h-3 w-3 animate-spin" />}Remove</button>
      <button type="button" onClick={() => setConfirming(false)} className="font-medium underline">Keep it</button>
    </div>}
  </div>;
}

/**
 * Every way the client can pay where no method is saved yet: PayPal or Pay Later
 * in a window over this page, or the Sandbox test card in one click. A checkbox
 * asks for consent to save the method for the project's later holds.
 */
export function PayMethodChooser({ options, paypal, testCardBusy, disabled, save, onSaveChange, onTestCard }: {
  options: CheckoutView; paypal: PayPalHandlers; testCardBusy: boolean; disabled: boolean;
  save: boolean; onSaveChange: (save: boolean) => void; onTestCard: () => void;
}) {
  return <div className="max-w-[380px] space-y-3">
    {options.paypalClientId && <PayPalButtons clientId={options.paypalClientId} disabled={disabled} {...paypal} />}
    {options.testCard && <>
      {options.paypalClientId && <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--muted)]"><span className="h-px flex-1 bg-[var(--line)]" />or<span className="h-px flex-1 bg-[var(--line)]" /></div>}
      <button type="button" disabled={disabled} onClick={onTestCard}
        className="flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-white px-3 py-2.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--canvas)]">{testCardBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold text-[var(--ink)]">Pay with the Sandbox test card</span><span className="block text-[10px] text-[var(--muted)]">Visa •••• 0026 · PayPal&apos;s test card, entered for you</span></span>
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800">Demo</span>
      </button>
    </>}
    {options.canSave && <label className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-600">
      <input type="checkbox" checked={save} disabled={disabled} onChange={(event) => onSaveChange(event.target.checked)} className="mt-0.5 accent-[var(--primary)]" />
      <span>Save this payment method for the project, so the studio can hold each approved item later without asking you again. You can remove it anytime.</span>
    </label>}
    {options.paypalClientId && options.sandboxBuyer && <SandboxBuyer buyer={options.sandboxBuyer} />}
  </div>;
}

/** The Sandbox buyer login, for whoever plays the client in the PayPal window. */
function SandboxBuyer({ buyer }: { buyer: { email: string; password: string } }) {
  return <details className="rounded-lg border border-dashed border-[var(--line)] px-3 py-2 text-[11px] text-slate-600">
    <summary className="cursor-pointer font-medium">Sandbox buyer login for the PayPal window</summary>
    <dl className="mt-2 space-y-1.5">
      <CopyRow label="Email" value={buyer.email} />
      <CopyRow label="Password" value={buyer.password} />
    </dl>
    <p className="mt-2 text-[10px] text-[var(--muted)]">A PayPal Sandbox test account. No real money moves.</p>
  </details>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="flex items-center gap-2">
    <dt className="w-16 shrink-0 text-[var(--muted)]">{label}</dt>
    <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink)]">{value}</dd>
    <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}
      className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]">{copied ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}</button>
  </div>;
}
