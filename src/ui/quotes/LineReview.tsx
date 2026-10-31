"use client";

import { Check, CircleSlash, Clock, LoaderCircle, MessageCircleQuestion, SendHorizontal, Undo2, X } from "lucide-react";
import { useState } from "react";
import { DECLINE_REASON_MAX, type LineState, type OpeningLine } from "@/opening/types";

/** What the client has chosen for a line on this page, before signing. */
export interface LineChoice {
  decision: "approved" | "declined";
  note: string;
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One badge per line: a signed decision, or the client's unsigned choice on this page. */
export function LineStateBadge({ state, choice, draft, forClient = false }: { state: LineState; choice?: LineChoice; draft: boolean; forClient?: boolean }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium leading-none";
  if (choice) return <span className={`${base} border border-dashed ${choice.decision === "approved" ? "border-emerald-300 text-emerald-700" : "border-red-300 text-red-700"}`}>{choice.decision === "approved" ? "To approve" : "To decline"}</span>;
  if (state === "approved") return <span className={`${base} bg-emerald-50 text-emerald-700`}><Check className="h-3 w-3" />Approved</span>;
  if (state === "declined") return <span className={`${base} bg-red-50 text-red-700`}><X className="h-3 w-3" />Declined</span>;
  if (state === "withdrawn") return <span className={`${base} bg-slate-100 text-slate-500`}><CircleSlash className="h-3 w-3" />Dropped</span>;
  return draft ? <span className={`${base} bg-slate-100 text-slate-600`}>Draft</span> : <span className={`${base} bg-amber-50 text-amber-800`}><Clock className="h-3 w-3" />{forClient ? "Needs your decision" : "Awaiting client"}</span>;
}

/**
 * The decision part of a line's details. The client chooses here and signs all
 * choices at once in the signing bar; a question goes to the chat right away.
 */
export function LineReview({ name, line, role, canDecide, canResolve, choice, onChoose, onAsk, onOpenChat, startDropping = false, onDrop, onRevise }: {
  name: string;
  line: OpeningLine;
  role: "designer" | "client";
  /** The client may still decide this line on the open V1. */
  canDecide: boolean;
  /** The designer may still drop or revise this line on the open V1. */
  canResolve: boolean;
  choice?: LineChoice;
  onChoose: (choice: LineChoice | null) => void;
  onAsk: (text: string) => Promise<string | null>;
  onOpenChat: () => void;
  /** Opened from "Drop…" or "Withdraw…": the confirmation shows straight away. */
  startDropping?: boolean;
  onDrop: () => Promise<string | null>;
  /** Opens the pricing page on a designer draft with this line; returns an error to show, or null. */
  onRevise: () => Promise<string | null>;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(startDropping && canResolve);

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setError(null);
    const failure = await onAsk(question.trim());
    setAsking(false);
    if (failure) setError(failure);
    else { setQuestion(""); setNotice("Sent to the project chat with this item tagged."); }
  }

  async function revise() {
    setError(null);
    const failure = await onRevise();
    if (failure) setError(failure);
  }

  async function drop() {
    setError(null);
    const failure = await onDrop();
    if (failure) setError(failure);
    setConfirmDrop(false);
  }

  const record = line.state === "approved" ? `Approved by ${line.by}` : line.state === "declined" ? `Declined by ${line.by}` : line.state === "withdrawn" ? `Dropped by ${line.by}` : null;
  return (
    <div className="mt-5 border-t border-brand-100 pt-4 text-[12px]">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Decision</div>
      {record && <p className="leading-relaxed"><strong className="font-medium">{record}</strong>{line.decidedAt && ` · ${dateTime(line.decidedAt)}`}{line.note && <span className="mt-1 block text-slate-600">Reason: &ldquo;{line.note}&rdquo;</span>}</p>}
      {!record && !canDecide && <p className="text-slate-600">{role === "client" ? "No decision yet." : "The client has not decided on this line yet."}</p>}

      {canDecide && <div className="space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={`Decision for ${name}`}>
          <button aria-pressed={choice?.decision === "approved"} onClick={() => onChoose({ decision: "approved", note: "" })} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium ${choice?.decision === "approved" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-[var(--line)] bg-white hover:bg-emerald-50"}`}><Check className="h-3.5 w-3.5" />Approve</button>
          <button aria-pressed={choice?.decision === "declined"} onClick={() => onChoose({ decision: "declined", note: choice?.decision === "declined" ? choice.note : "" })} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium ${choice?.decision === "declined" ? "border-red-400 bg-red-50 text-red-700" : "border-[var(--line)] bg-white hover:bg-red-50"}`}><X className="h-3.5 w-3.5" />Decline</button>
          <button aria-pressed={!choice} onClick={() => onChoose(null)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium ${!choice ? "border-slate-400 bg-slate-50" : "border-[var(--line)] bg-white hover:bg-slate-50"}`}><Undo2 className="h-3.5 w-3.5" />Decide later</button>
        </div>
        {choice?.decision === "declined" && <label className="block">
          <span className="mb-1 block text-[11px] text-slate-600">Why are you declining it? The designer sees this and can revise the item.</span>
          <textarea value={choice.note} onChange={(event) => onChoose({ decision: "declined", note: event.target.value })} maxLength={DECLINE_REASON_MAX} rows={2} placeholder="For example: too big for the room" className="w-full rounded-lg border border-[var(--line)] bg-white px-2.5 py-2 outline-none focus:border-brand-200" />
        </label>}
        <p className="text-[11px] text-[var(--muted)]">Your choice is saved when you sign below. You can leave lines undecided and sign them later.</p>
      </div>}

      {line.state !== "withdrawn" && <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] text-slate-600"><MessageCircleQuestion className="h-3.5 w-3.5 text-[var(--primary)]" />{line.questions ? <button onClick={onOpenChat} className="font-medium text-[var(--primary)] hover:underline">{line.questions} {line.questions === 1 ? "message" : "messages"} about this item in the chat</button> : "No messages about this item yet."}</div>
        {canDecide && <div className="flex items-start gap-2">
          <textarea aria-label={`Ask about ${name}`} value={question} onChange={(event) => setQuestion(event.target.value)} rows={1} maxLength={2000} placeholder="Ask about this item…" className="min-h-[36px] flex-1 resize-y rounded-lg border border-[var(--line)] bg-white px-2.5 py-2 outline-none focus:border-brand-200" />
          <button onClick={() => void ask()} disabled={!question.trim() || asking} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{asking ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}Ask</button>
        </div>}
      </div>}

      {canResolve && <div className="mt-4 flex flex-wrap items-center gap-2">
        {line.state === "declined" && <button onClick={() => void revise()} className="rounded-lg bg-[var(--primary-fill)] px-3 py-1.5 font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">Revise in a new version</button>}
        {confirmDrop
          ? <><button onClick={() => void drop()} className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 font-medium text-red-700 hover:bg-red-100">Confirm: drop {name}</button><button onClick={() => setConfirmDrop(false)} className="px-2 py-1.5 text-slate-500 hover:underline">Cancel</button></>
          : <button onClick={() => setConfirmDrop(true)} className="rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 font-medium hover:bg-slate-50">{line.state === "declined" ? "Drop item" : "Withdraw item"}</button>}
      </div>}

      {notice && <p role="status" className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-brand-800">{notice}</p>}
      {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-red-800">{error}</p>}
    </div>
  );
}
