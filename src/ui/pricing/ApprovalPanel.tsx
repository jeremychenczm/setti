"use client";

import { LoaderCircle, LockKeyhole, PenLine, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalWorkspace, DecideChangeOrderInput } from "@/approval/types";
import { dateTime, Field, inputClass, signedMoney } from "./common";
import { useDemoMode } from "../demo-mode";

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

/** What the demo client says to the designer when confirming, prefilled and editable; it is their message in the chat. */
/** The note a client sends with a confirmation, addressed to the order's designer by first name. */
export const confirmationNote = (version: number, designerName: string) => `Thanks, ${designerName.replace(/\s*\(demo designer\)$/, "").split(" ")[0]}. V${version} looks right to me, so please go ahead and place the orders.`;
const today = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

interface ApprovalPanelProps {
  workspace: ApprovalWorkspace;
  loading: boolean;
  onChange: (workspace: ApprovalWorkspace) => void;
  onBusyChange: (busy: boolean) => void;
}

export function ApprovalPanel({ workspace, loading, onChange, onBusyChange }: ApprovalPanelProps) {
  const { view, canDecide, clientName } = workspace;
  const { order, decision } = view;
  const demo = useDemoMode();
  // The demo fills in the client's review, signature and message so a test confirmation is one click; each stays editable.
  // A real client types their own name, writes their own message and ticks the acknowledgement themselves.
  const [signature, setSignature] = useState(demo ? clientName ?? "" : "");
  const [note, setNote] = useState(() => demo ? confirmationNote(order.version, order.designerName) : "");
  const [acknowledged, setAcknowledged] = useState(demo);
  const [busy, setBusy] = useState<"approved" | "changes_requested" | "check" | null>(null);
  const [pending, setPending] = useState<DecideChangeOrderInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Asking for changes instead of signing: the same card, with a request in place of the signature button.
  const [asking, setAsking] = useState(false);
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

  const designerFirst = order.designerName.replace(/\s*\(demo designer\)$/, "").split(" ")[0];
  const card = "rounded-xl border border-[var(--line)] bg-white p-5";
  const sentOn = new Date(order.issuedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  const ask = (on: boolean) => {
    setAsking(on);
    // The prefilled thanks belongs to signing; a request starts empty.
    if (on && note === confirmationNote(order.version, order.designerName)) setNote("");
  };
  const fact = (label: string, value: ReactNode) => <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] py-2.5 text-[12.5px]"><dt className="text-[var(--muted)]">{label}</dt><dd className="m-0 text-right font-semibold">{value}</dd></div>;

  return (
    <div className="grid gap-4">
      {decision && <section className={card} aria-labelledby="client-decision-title">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">{decision.decision === "approved" ? "Signed" : "Returned"} · {dateTime(decision.decidedAt)} PT</p>
        <h2 id="client-decision-title" className="mt-0.5 text-[15px] font-bold">{decision.decision === "approved" ? `V${order.version} signed` : `Changes requested for V${order.version}`}</h2>
        {decision.decision === "changes_requested" && decision.note && <p className="mt-3 whitespace-pre-wrap border-l-[3px] border-[var(--primary-line)] py-1 pl-3 text-[12.5px] text-slate-700">{decision.note}</p>}
        <dl className="mt-3 border-t border-[var(--line)]">
          {fact("Signed as", <span className="font-signature text-[20px] font-normal leading-none">{decision.signature.replace(/\s*\(demo signature\)$/, "")}</span>)}
          {fact("Recorded against", "This exact version and its fingerprint")}
          {decision.decision === "approved" && view.status !== "superseded" && fact("Money", "Unneeded holds released, new items held")}
          {decision.decision === "changes_requested" && fact("Money", "Nothing moved")}
          {decision.decision === "approved" && decision.note && fact("Message", <span className="font-normal text-slate-600">{decision.note}</span>)}
        </dl>
        {clientName && <div className="mt-3 flex justify-end"><a href={`/chats/${order.projectKey}`} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]">Open the project chat</a></div>}
      </section>}
      {canDecide && !decision && <>
        <section className={card} aria-labelledby="client-decision-title">
          <h2 id="client-decision-title" className="text-[15px] font-bold">Your decision on V{order.version}</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-600">{designerFirst} sent V{order.version} on {sentOn}. It changes your signed V{order.basedOnVersion} by <b className="text-[var(--ink)]">{signedMoney(order.deltaTotalCents)}</b>.{demo ? " Reviewing as Emma in this demo." : ""}</p>
          {asking
            ? <p className="mt-2 text-[12px] text-slate-600">Tell {designerFirst} what to change below. V{order.version} stays unsigned and nothing moves. <button type="button" onClick={() => ask(false)} className="font-semibold text-[var(--primary)] underline">Back to signing</button></p>
            : <button type="button" onClick={() => ask(true)} className="mt-2 text-[12px] font-semibold text-[var(--primary)] underline">Ask for changes instead</button>}
        </section>
        <section className={card} aria-label={asking ? "Ask for changes" : `Sign V${order.version}`}>
          <h3 className="text-[15px] font-bold">{asking ? "Ask for changes" : `Sign V${order.version}`}</h3>
          <p className="mt-1 text-[11.5px] text-[var(--muted)]">{asking ? `Your message goes to ${designerFirst} in the project chat.` : `Covers V${order.version} exactly as shown, with its terms.`}</p>
          <fieldset disabled={disabled} className="mt-3 grid gap-3">
            <label className="flex cursor-pointer items-start gap-2 text-[12px] text-slate-600"><input type="checkbox" aria-label="Reviewed this exact change-order version" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5 accent-emerald-700" /><span>I have read V{order.version} and its terms.</span></label>
            <Field label="Type your full name" hint={demo && signature.trim() === clientName ? "Prefilled for the demo. It must read your full name." : `Type your full name exactly: ${clientName ?? ""}`}><input aria-label="Demo client confirmation name" autoComplete="off" value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={160} className={inputClass} /></Field>
            <div aria-hidden className="flex min-h-[60px] items-end gap-2.5 border-b-[1.5px] border-[var(--ink)] px-0.5 pb-1"><span className="pb-1.5 text-[18px] text-[var(--muted)]">×</span><span className="truncate font-signature text-[34px] leading-none text-[var(--ink)]">{signature.trim()}</span></div>
            <div className="-mt-1.5 flex justify-between gap-3 text-[11px] text-[var(--muted)]"><span>{clientName} · Client</span><span>{today()} · V{order.version}</span></div>
            <Field label={asking ? `What should ${designerFirst} change?` : `Message to ${designerFirst}`} hint={asking ? "Required." : "Sent to the project chat with your signature."}><textarea aria-label="Client decision note" value={note} onChange={(event) => setNote(event.target.value)} rows={asking ? 4 : 3} maxLength={3000} className={inputClass} /></Field>
            <div className="flex justify-end">{asking
              ? <button type="button" onClick={() => decide("changes_requested")} disabled={!ready || !note.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-[#1f241d] disabled:bg-slate-200 disabled:text-slate-400">{busy === "changes_requested" && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Send to {designerFirst}</button>
              : <button type="button" onClick={() => decide("approved")} disabled={!ready} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy === "approved" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}Sign V{order.version}</button>}</div>
          </fieldset>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{asking ? "Requesting changes moves no money." : "Signing charges nothing by itself. Right after, Setti releases the holds this version no longer needs and places its new holds."}</p>
        </section>
      </>}
      {notice && <p role="status" className="rounded-lg bg-brand-50 p-3 text-[12px] leading-relaxed text-brand-900">{notice}</p>}
      {error && <div role="alert" className="rounded-lg border border-red-100 bg-red-50 p-3 text-[12px] leading-relaxed text-red-900"><p>{error}</p>{pending && <div className="mt-3 flex flex-wrap gap-3"><button onClick={() => void checkSavedStatus()} disabled={Boolean(busy) || loading} className="inline-flex items-center gap-1.5 font-semibold underline disabled:opacity-50">{busy === "check" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Check saved status</button><button onClick={() => void submit(pending)} disabled={Boolean(busy) || loading} className="font-semibold underline disabled:opacity-50">Retry the same {pending.decision === "approved" ? "signature" : "request"}</button></div>}</div>}
      {!canDecide && !decision && <p className={`${card} flex items-start gap-2 text-[12px] leading-relaxed text-slate-600`}><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />{workspace.reason ?? (demo ? "This is a read-only shared review. Return to the owning demo project session to make a client decision." : "This is a read-only shared review. Sign in as the project's client to make a decision.")}</p>}
    </div>
  );
}
