"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { DECLINE_REASON_MAX } from "@/opening/types";

/**
 * A row between the table's filters and its header, shown while lines are
 * ticked, so the choices for those lines sit right above them.
 */
export function BulkDecisionBar({ count, onApprove, onDecline, onUndecide, onClear }: {
  count: number;
  onApprove: () => void;
  /** One reason for every ticked line; each line's reason can still be edited on its own. */
  onDecline: (reason: string) => void;
  onUndecide: () => void;
  onClear: () => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = () => { setDeclining(false); setReason(""); };
  const button = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium";

  return <div role="toolbar" aria-label="Ticked lines" className="border-b border-[var(--line)] bg-white px-4 py-2.5 text-[12px]">
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 font-medium tabular-nums text-[var(--ink)]">{count} ticked</span>
      <button onClick={onApprove} className={`${button} bg-[var(--primary-fill)] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]`}><Check className="h-3.5 w-3.5" />Approve ticked</button>
      <button onClick={() => setDeclining(true)} className={`${button} border border-red-300 bg-white text-red-700 hover:bg-red-50`}>Decline ticked</button>
      <button onClick={onUndecide} className={`${button} border border-[var(--line)] bg-white text-slate-700 hover:bg-[var(--canvas)]`}>Decide later</button>
      <button onClick={onClear} className="px-2 py-1.5 text-slate-600 hover:underline">Clear ticks</button>
    </div>
    {declining && <div className="mt-2 flex flex-wrap items-center gap-2">
      <input aria-label="Reason for declining the ticked lines" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") cancel(); }} maxLength={DECLINE_REASON_MAX}
        placeholder="Why are you declining these lines? For example: over budget" className="min-w-0 flex-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 outline-none focus:border-red-400" />
      <button onClick={() => { onDecline(reason.trim()); cancel(); }} disabled={!reason.trim()} className={`${button} bg-red-600 text-white hover:bg-red-700 disabled:bg-red-200`}>Decline {count} with this reason</button>
      <button onClick={cancel} className="px-2 py-1.5 text-slate-600 hover:underline">Cancel</button>
    </div>}
  </div>;
}
