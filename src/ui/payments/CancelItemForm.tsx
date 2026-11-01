"use client";

import { Ban, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { CANCELLATION_REASON_TEXT, CANCELLATION_REASONS, cancellationMessage, type CancellationReason } from "@/payments/cancellation";
import type { ItemCancellationView } from "@/payments/types";
import { dateTime, Field, inputClass, money } from "../pricing/common";

/**
 * Why the studio cancels an item, asked before anything is released. The
 * client reads it in the project chat as a message from the designer, so the
 * form shows that exact message first. "Other" needs the designer's own words.
 */
export function CancelItemForm({ itemName, heldCents, designer, disabled, busy, onBack, onSubmit }: {
  itemName: string; heldCents: number; designer: string; disabled: boolean; busy: boolean; onBack: () => void; onSubmit: (reason: CancellationReason, note: string) => void;
}) {
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [text, setText] = useState("");
  const missing = !reason || (reason === "other" && !text.trim());
  return <div className="space-y-3">
    <fieldset>
      <legend className="text-[12px] font-semibold">Why is this item cancelled?</legend>
      <div className="mt-2 space-y-1.5">{CANCELLATION_REASONS.map((value) => <label key={value} className="flex items-center gap-2 text-[12px] text-slate-700">
        <input type="radio" name={`cancel-reason-${itemName}`} value={value} checked={reason === value} onChange={() => setReason(value)} className="accent-[var(--primary)]" />{CANCELLATION_REASON_TEXT[value]}
      </label>)}</div>
    </fieldset>
    <Field label={reason === "other" ? "What happened" : "Note for the client · optional"}>
      <textarea className={`${inputClass} min-h-[64px] resize-y`} value={text} onChange={(event) => setText(event.target.value)} maxLength={1_000}
        placeholder={reason === "other" ? "The client reads this in the chat." : "For example: the supplier discontinued this finish."} />
    </Field>
    {reason && !missing && <div className="rounded-lg bg-[var(--canvas)] p-2.5 text-[11px] leading-relaxed text-slate-600">
      <p className="font-medium text-slate-700">Setti sends this to the client in the chat, as you ({designer}):</p>
      <p className="mt-1 italic">&ldquo;{cancellationMessage({ itemName, reason, note: text, heldCents })}&rdquo;</p>
    </div>}
    <p className="text-[11px] leading-relaxed text-[var(--muted)]">{heldCents > 0 ? `PayPal releases the ${money(heldCents)} hold; nothing is charged.` : "Nothing is held or charged for this item."} A replacement would come as a new version for the client to confirm.</p>
    <button type="button" disabled={disabled || missing} onClick={() => reason && onSubmit(reason, text.trim())}
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-700 px-3.5 py-2.5 text-[13px] font-semibold text-white hover:bg-red-800 disabled:opacity-50">
      {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}{heldCents > 0 ? `Cancel and release ${money(heldCents)}` : "Cancel this item"}</button>
    <button type="button" disabled={busy} onClick={onBack} className="inline-flex w-full justify-center text-[12px] font-medium text-slate-600 hover:underline disabled:opacity-50">Keep the item</button>
  </div>;
}

/** The recorded cancellation, as both payment pages show it. */
export function CancellationRecord({ cancellation }: { cancellation: ItemCancellationView }) {
  return <dl className="divide-y divide-[var(--line)] text-[12px]">
    <div className="flex items-baseline justify-between gap-3 py-1"><dt className="text-[var(--muted)]">Reason</dt><dd className="text-right">{cancellation.reason === "other" ? cancellation.note : cancellation.reasonText}</dd></div>
    {cancellation.reason !== "other" && cancellation.note && <div className="flex items-baseline justify-between gap-3 py-1"><dt className="text-[var(--muted)]">Note</dt><dd className="text-right">{cancellation.note}</dd></div>}
    <div className="flex items-baseline justify-between gap-3 py-1"><dt className="text-[var(--muted)]">By</dt><dd className="text-right">{cancellation.by} · {dateTime(cancellation.at)}</dd></div>
  </dl>;
}
