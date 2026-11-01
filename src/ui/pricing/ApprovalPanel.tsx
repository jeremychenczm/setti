"use client";

import { Check, ClipboardCheck, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApprovalWorkspace, DecideChangeOrderInput } from "@/approval/types";
import { dateTime, Field, inputClass } from "./common";
import { FundingImpactPreview } from "./FundingImpactPreview";

export function isApprovalWorkspace(value: unknown, orderId: string): value is ApprovalWorkspace {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<ApprovalWorkspace>;
  return body.view?.order?.id === orderId && typeof body.canDecide === "boolean" && "fundingPlan" in body;
}

async function requestWorkspace(orderId: string, input?: DecideChangeOrderInput): Promise<ApprovalWorkspace> {
  const response = await fetch(`/api/change-orders/${encodeURIComponent(orderId)}/approval`, {
    cache: "no-store",
    ...(input ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? String(body.error) : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  if (!isApprovalWorkspace(body, orderId)) throw new Error("The server returned an incomplete client review.");
  return body;
}

interface ApprovalPanelProps {
  workspace: ApprovalWorkspace;
  loading: boolean;
  onChange: (workspace: ApprovalWorkspace) => void;
  onBusyChange: (busy: boolean) => void;
}

export function ApprovalPanel({ workspace, loading, onChange, onBusyChange }: ApprovalPanelProps) {
  const { view, canDecide, clientName } = workspace;
  const { order, decision } = view;
  const [signature, setSignature] = useState("");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"approved" | "changes_requested" | "check" | null>(null);
  const [pending, setPending] = useState<DecideChangeOrderInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const mutating = useRef(false);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabled = loading || Boolean(busy) || Boolean(pending);
  const ready = canDecide && !disabled && acknowledged && signature.trim() === clientName;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (leaving.current) clearTimeout(leaving.current); };
  }, []);

  function accept(next: ApprovalWorkspace) {
    onChange(next);
    setPending(null);
    setError(null);
    setNotice(next.view.decision?.decision === "approved"
      ? `Your confirmation of V${order.version} is saved.`
      : next.view.decision ? `Your request to adjust V${order.version} is saved. Discuss the changes with the designer.` : null);
  }

  async function reconcile(input: DecideChangeOrderInput) {
    const next = await requestWorkspace(order.id);
    if (!alive.current) return;
    onChange(next);
    if (next.view.decision || next.view.status !== "awaiting_client_confirmation" || !next.canDecide) {
      accept(next);
      if (!next.view.decision) setError(next.reason ?? "This version can no longer receive a decision.");
      else if (next.view.decision.decision !== input.decision) setNotice("A client decision is already saved for this version. The saved result is shown below.");
      return;
    }
    setPending(input);
    setError("No saved decision is visible yet. Check the saved status or retry this same request before making another decision.");
  }

  async function submit(input: DecideChangeOrderInput) {
    if (mutating.current || loading) return;
    mutating.current = true;
    setBusy(input.decision);
    onBusyChange(true);
    setError(null);
    setNotice(null);
    try {
      const next = await requestWorkspace(order.id, input);
      if (alive.current) accept(next);
      // Confirming is the client's step; the chat shows the hand-off to the designer, as after the first payment.
      if (alive.current && input.decision === "approved" && next.view.decision?.decision === "approved") {
        setNotice(`Your confirmation of V${order.version} is saved. Opening the project chat…`);
        leaving.current = setTimeout(() => window.location.assign(`/chats/${order.projectKey}`), 1500);
      }
    } catch (cause) {
      if (!alive.current) return;
      setPending(input);
      setError(cause instanceof Error ? cause.message : "The decision could not be confirmed.");
      try { await reconcile(input); }
      catch { if (alive.current) setError("The response was lost and the saved result could not be checked. Check saved status before continuing."); }
    } finally {
      mutating.current = false;
      if (alive.current) { setBusy(null); onBusyChange(false); }
    }
  }

  async function checkSavedStatus() {
    if (!pending || mutating.current || loading) return;
    mutating.current = true;
    setBusy("check");
    onBusyChange(true);
    try { await reconcile(pending); }
    catch { if (alive.current) setError("Saved status is temporarily unavailable. Your original request is kept; check again before continuing."); }
    finally {
      mutating.current = false;
      if (alive.current) { setBusy(null); onBusyChange(false); }
    }
  }

  function decide(kind: DecideChangeOrderInput["decision"]) {
    if (!ready || (kind === "changes_requested" && !note.trim())) return;
    void submit({
      decision: kind,
      contentHash: order.contentHash,
      revisionContentHash: order.revisionContentHash,
      acknowledged: true,
      signature: signature.trim(),
      note: note.trim(),
    });
  }

  return <>
    <FundingImpactPreview order={order} plan={workspace.fundingPlan} status={view.status} canView={clientName !== null} />
    <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="client-decision-title">
      <h2 id="client-decision-title" className="flex items-center gap-2 text-[16px] font-semibold"><ClipboardCheck className="h-4.5 w-4.5 text-[var(--primary)]" />Client review · V{order.version}</h2>
      {decision && <div role="status" className={`mt-4 rounded-xl border p-4 text-[12px] leading-relaxed ${decision.decision === "approved" ? "border-emerald-100 bg-emerald-50 text-emerald-900" : "border-amber-100 bg-amber-50 text-amber-900"}`}>
        <p className="flex items-center gap-1.5 font-semibold">{decision.decision === "approved" && <Check className="h-4 w-4" />}{decision.decision === "approved" ? `V${order.version} confirmed` : `Changes requested for V${order.version}`}</p>
        <p className="mt-2">{decision.clientName} · {dateTime(decision.decidedAt)} PT</p>
        <p className="mt-1 text-[11px]">Recorded with the exact frozen content and quote revision. Demo client decision.</p>
        {decision.note && <p className="mt-3 whitespace-pre-wrap border-t border-current/10 pt-3">{decision.note}</p>}
        {decision.decision === "approved" && view.status !== "superseded" && <p className="mt-3 text-[11px]">This confirmed version is the baseline for the next change. With a saved payment method, its new items are held right away; releases, captures and refunds are separate steps.</p>}
      </div>}
      {notice && <p role="status" className="mt-4 rounded-lg bg-brand-50 p-3 text-[12px] leading-relaxed text-brand-900">{notice}</p>}
      {error && <div role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900"><p>{error}</p>{pending && <div className="mt-3 flex flex-wrap gap-3"><button onClick={() => void checkSavedStatus()} disabled={Boolean(busy) || loading} className="inline-flex items-center gap-1.5 font-semibold underline disabled:opacity-50">{busy === "check" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check saved status</button><button onClick={() => void submit(pending)} disabled={Boolean(busy) || loading} className="font-semibold underline disabled:opacity-50">Retry the same {pending.decision === "approved" ? "confirmation" : "request"}</button></div>}</div>}
      {canDecide && !decision && <div className="mt-4">
        <p className="rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">Reviewing as <strong className="font-semibold text-slate-800">{clientName}</strong> in this demo session. The shared link alone does not grant confirmation permission.</p>
        <fieldset disabled={disabled} className="mt-4 space-y-4">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-brand-100 bg-brand-50/50 p-3 text-[12px] leading-relaxed"><input type="checkbox" aria-label="Reviewed this exact change-order version" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" /><span>I have reviewed the complete V{order.version} quote, changes, prices and client terms. My decision applies to this exact version.</span></label>
          <div className="grid gap-4 md:grid-cols-2"><Field label="Type the demo client name" hint={`Enter exactly: ${clientName ?? ""}`}><input aria-label="Demo client confirmation name" autoComplete="off" value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={160} className={inputClass} /></Field><Field label="Message to the designer" hint="Required when requesting adjustments; optional when confirming."><textarea aria-label="Client decision note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={3000} className={inputClass} /></Field></div>
          <div className="flex flex-wrap items-center gap-3"><button onClick={() => decide("approved")} disabled={!ready} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2.5 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy === "approved" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Confirm V{order.version} · scope, prices and terms</button><button onClick={() => decide("changes_requested")} disabled={!ready || !note.trim()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">{busy === "changes_requested" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Request adjustments</button></div>
        </fieldset>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Confirming records agreement to this version. Neither button places a supplier order, authorizes funds, charges or refunds money.</p>
      </div>}
      {!canDecide && !decision && <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />{workspace.reason ?? "This is a read-only shared review. Return to the owning demo project session to make a client decision."}</p>}
      {clientName && decision && <a href={`/chats/${order.projectKey}`} className="mt-4 inline-block text-[12px] font-medium text-[var(--primary)] underline">Return to the project conversation</a>}
    </section>
  </>;
}

