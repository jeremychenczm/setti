"use client";

import { CalendarClock, Check, Copy, CreditCard, LoaderCircle, LockKeyhole, Wallet } from "lucide-react";
import { useId, useState } from "react";
import type { SavedMethodView } from "@/payments/saved-methods";
import type { CheckoutView } from "@/payments/types";
import { PayPalButton, type PayPalHandlers } from "./PayPalButtons";

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

type Method = "paypal" | "paylater" | "card";

/**
 * Every way the client can pay where no method is saved yet, as one list:
 * PayPal or Pay Later in a window over this page, or the Sandbox test card in
 * one click. Only the chosen method's button shows. A checkbox asks for consent
 * to save the method for the project's later holds.
 */
export function PayMethodChooser({ options, paypal, testCardBusy, disabled, save, onSaveChange, onTestCard }: {
  options: CheckoutView; paypal: PayPalHandlers; testCardBusy: boolean; disabled: boolean;
  save: boolean; onSaveChange: (save: boolean) => void; onTestCard: () => void;
}) {
  const group = useId();
  const methods: { id: Method; title: string; detail: string; icon: typeof Wallet; demo?: boolean }[] = [
    ...(options.paypalClientId ? [
      { id: "paypal" as const, title: "PayPal", detail: "Log in to PayPal in a window over this page", icon: Wallet },
      { id: "paylater" as const, title: "Pay Later", detail: "Pay in 4 or monthly, with PayPal", icon: CalendarClock },
    ] : []),
    ...(options.testCard ? [{ id: "card" as const, title: "Card", detail: "Visa •••• 0026 · PayPal's Sandbox test card", icon: CreditCard, demo: true }] : []),
  ];
  const [chosen, setChosen] = useState<Method | null>(null);
  const method = methods.find((entry) => entry.id === chosen)?.id ?? methods[0]?.id;

  return <div className="max-w-[420px] space-y-3">
    <div role="radiogroup" aria-label="Payment method" className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
      {methods.map((entry, index) => {
        const selected = entry.id === method;
        const Icon = entry.icon;
        return <div key={entry.id} className={index ? "border-t border-[var(--line)]" : undefined}>
          <label className={`flex cursor-pointer items-center gap-3 px-3.5 py-3 ${selected ? "" : "hover:bg-[var(--canvas)]"}`}>
            <input type="radio" name={group} checked={selected} disabled={disabled} onChange={() => setChosen(entry.id)} className="h-4 w-4 shrink-0 accent-[var(--ink)]" />
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected ? "bg-[var(--ink)] text-white" : "bg-[var(--canvas)] text-slate-600"}`}><Icon className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-[var(--ink)]">{entry.title}</span>
              <span className="block truncate text-[11px] text-[var(--muted)]">{entry.detail}</span>
            </span>
            {entry.demo && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">Demo</span>}
          </label>
          {selected && <div className="px-3.5 pb-3.5">
            {entry.id === "card"
              ? <>
                <button type="button" disabled={disabled} onClick={onTestCard}
                  className="inline-flex h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary-fill)] text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50">
                  {testCardBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}Pay with the test card
                </button>
                <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">Setti enters PayPal&apos;s Sandbox test card for you. No real money moves.</p>
              </>
              : options.paypalClientId && <PayPalButton clientId={options.paypalClientId} funding={entry.id} disabled={disabled} {...paypal} />}
          </div>}
        </div>;
      })}
    </div>
    {options.canSave && <label className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-600">
      <input type="checkbox" checked={save} disabled={disabled} onChange={(event) => onSaveChange(event.target.checked)} className="mt-0.5 accent-[var(--primary)]" />
      <span>Save this payment method for the project. Approved products are held with it, one at a time, without asking you again. You can remove it anytime.</span>
    </label>}
    {method !== "card" && options.paypalClientId && options.sandboxBuyer && <SandboxBuyer buyer={options.sandboxBuyer} />}
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
