"use client";

import { LoaderCircle, PenLine } from "lucide-react";
import { useState } from "react";
import { DECLINE_REASON_MAX } from "@/opening/types";
import { usd } from "../demo-data";

/**
 * The client's signature for the choices made on the page, fixed at the bottom
 * of the quote. One signature covers every chosen line; undecided lines stay
 * open for a later signature. Lines ticked in the table can be set in one go.
 */
export function SignBar({ clientName, approveCount, approveCents, declineCount, undecided, missingReasons, selectedCount, onApproveRest, onApproveSelected, onDeclineSelected, onUndecideSelected, onClearSelection, onSign }: {
  clientName: string;
  approveCount: number;
  approveCents: number;
  declineCount: number;
  /** Lines with no choice yet, which this signature leaves open. */
  undecided: number;
  /** Declined lines that still need a reason. */
  missingReasons: string[];
  /** Lines ticked in the table. */
  selectedCount: number;
  onApproveRest: () => void;
  onApproveSelected: () => void;
  /** One reason for every ticked line; each line's reason can still be edited on its own. */
  onDeclineSelected: (reason: string) => void;
  onUndecideSelected: () => void;
  onClearSelection: () => void;
  /** Returns an error to show, or null once signed. */
  onSign: (signature: string) => Promise<string | null>;
}) {
  const [signature, setSignature] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const chosen = approveCount + declineCount;
  const ready = chosen > 0 && acknowledged && signature.trim() === clientName && !missingReasons.length && !signing;

  async function sign() {
    if (!ready) return;
    setSigning(true);
    setError(null);
    const failure = await onSign(signature.trim());
    setSigning(false);
    if (failure) setError(failure);
    else { setSignature(""); setAcknowledged(false); }
  }

  return (
    <div aria-label="Sign your decisions" className="shrink-0 border-t-2 border-amber-300 bg-amber-50 px-5 py-3 lg:px-9">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <span className="font-semibold text-amber-950">Your decisions</span>
        <span className="text-emerald-700">{approveCount} to approve{approveCount ? ` · ${usd(approveCents)}` : ""}</span>
        <span className="text-red-700">{declineCount} to decline</span>
        <span className="text-slate-600">{undecided} undecided</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {selectedCount > 0 ? <>
            <span className="font-medium text-amber-950">{selectedCount} ticked</span>
            <button onClick={onApproveSelected} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700">Approve ticked</button>
            <button onClick={() => setDeclining(true)} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-50">Decline ticked</button>
            <button onClick={onUndecideSelected} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100">Decide later</button>
            <button onClick={onClearSelection} className="px-2 py-1.5 text-slate-600 hover:underline">Clear ticks</button>
          </> : undecided > 0 && <button onClick={onApproveRest} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100">Approve all {undecided} remaining</button>}
        </span>
      </div>
      {declining && selectedCount > 0 && <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px]">
        <input aria-label="Reason for declining the ticked lines" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} maxLength={DECLINE_REASON_MAX} placeholder="Why are you declining these lines? For example: over budget" className="min-w-0 flex-1 rounded-lg border border-red-200 bg-white px-2.5 py-2 outline-none focus:border-red-400" />
        <button onClick={() => { onDeclineSelected(reason.trim()); setDeclining(false); setReason(""); }} disabled={!reason.trim()} className="rounded-lg bg-red-600 px-3 py-2 font-medium text-white hover:bg-red-700 disabled:bg-red-200">Decline {selectedCount} with this reason</button>
        <button onClick={() => { setDeclining(false); setReason(""); }} className="px-2 py-2 text-slate-600 hover:underline">Cancel</button>
      </div>}
      {missingReasons.length > 0 && <p className="mt-2 text-[11px] text-red-700">Add a reason for declining: {missingReasons.join(", ")}.</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        <input aria-label="Client signature" placeholder={`Type ${clientName} to sign`} value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={160} autoComplete="off" className="w-56 rounded-lg border border-amber-300 bg-white px-2.5 py-2 text-[13px] outline-none focus:border-amber-500" />
        <label className="flex max-w-lg flex-1 cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-slate-700"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" />I reviewed the lines I am deciding, with their prices and terms. Each decision applies to this locked V1 and cannot be changed afterwards. Nothing is charged.</label>
        <button onClick={() => void sign()} disabled={!ready} className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2.5 text-[12px] font-semibold text-white hover:bg-blue-600 disabled:bg-amber-100 disabled:text-amber-700/60">{signing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}Sign {chosen || ""} {chosen === 1 ? "decision" : "decisions"}</button>
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
    </div>
  );
}
