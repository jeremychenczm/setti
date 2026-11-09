"use client";

import { Plus, X } from "lucide-react";
import { NON_REFUNDABLE_FEE_KINDS, NON_REFUNDABLE_FEE_LABEL } from "@/pricing/fees";
import type { NonRefundableFeeKind, PricingChangeInput } from "@/pricing/types";
import { centsText, inputClass, money } from "./common";
import { fieldKey, type RawFields } from "./PricingGrid";

/** The raw-text field of one fee's amount. */
export const feeField = (kind: NonRefundableFeeKind) => `fee:${kind}`;

/** What the supplier keeps from the old item and the client is not refunded, by type. */
export function OldItemFees({ change, raw, errors, onAmount, onKind, onRemove, onAdd, onNone }: {
  change: PricingChangeInput; raw: RawFields; errors: RawFields;
  onAmount: (kind: NonRefundableFeeKind, value: string) => void; onKind: (from: NonRefundableFeeKind, to: NonRefundableFeeKind) => void;
  onRemove: (kind: NonRefundableFeeKind) => void; onAdd: () => void; onNone: () => void;
}) {
  const fees = change.oldItemFees;
  const used = new Set(fees.map((fee) => fee.kind));
  const link = "inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--primary)] underline-offset-2 hover:underline";
  return <div role="group" aria-label="Non-refundable fees">
    <span className="mb-1.5 block text-[11px] font-medium text-slate-600">Non-refundable fees</span>
    {fees.length > 0 && <ul className="space-y-2">{fees.map((fee) => {
      const label = NON_REFUNDABLE_FEE_LABEL[fee.kind];
      const error = errors[fieldKey(change.key, feeField(fee.kind))];
      return <li key={fee.kind}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1"><select aria-label="Fee type" className={inputClass} value={fee.kind} onChange={(event) => onKind(fee.kind, event.target.value as NonRefundableFeeKind)}>
            {NON_REFUNDABLE_FEE_KINDS.filter((kind) => kind === fee.kind || !used.has(kind)).map((kind) => <option key={kind} value={kind}>{NON_REFUNDABLE_FEE_LABEL[kind]}</option>)}
          </select></div>
          <div className="w-28 shrink-0"><input aria-label={`${label} (USD)`} inputMode="decimal" placeholder="Amount (USD)" className={`${inputClass} tabular-nums`} value={raw[fieldKey(change.key, feeField(fee.kind))] ?? centsText(fee.amountCents)} onChange={(event) => onAmount(fee.kind, event.target.value)} /></div>
          <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(fee.kind)} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-3.5 w-3.5" /></button>
        </div>
        {error && <span role="alert" className="mt-1 block text-[10px] text-red-600">{error}</span>}
      </li>;
    })}</ul>}
    {!fees.length && <p className="text-[12px] text-slate-600">{change.oldItemCostCents === 0 ? "No non-refundable fee." : "Not checked yet."}</p>}
    {fees.length > 1 && change.oldItemCostCents !== null && <p className="mt-2 text-[12px] text-slate-600">Total <span className="font-semibold tabular-nums">{money(change.oldItemCostCents)}</span></p>}
    <div className="mt-2 flex flex-wrap gap-4">
      {fees.length < NON_REFUNDABLE_FEE_KINDS.length && <button type="button" onClick={onAdd} className={link}><Plus className="h-3.5 w-3.5" />Add a fee</button>}
      {!fees.length && change.oldItemCostCents === null && <button type="button" onClick={onNone} className={link}>No non-refundable fee</button>}
    </div>
    <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">Costs the supplier keeps, which the client pays and does not get back, including their tax. Use Other cost only when no type fits, and explain it in the note.</span>
  </div>;
}
