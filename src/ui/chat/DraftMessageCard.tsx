"use client";

import { ArrowRight, FileText } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import type { CaseKey, ChangeDraft, DraftChange, DraftItem } from "@/chat/types";
import type { PricingWorkspace } from "@/pricing/types";
import { draftEstimate, type DraftEstimate } from "./draft-pricing";
import { usd } from "./DraftCard";
import { quoteHref } from "@/quotes/links";
import { matchQuestion } from "../pricing/question-match";

/** "16 ft", "20 boxes", "14": the quantity with a short unit, so the columns stay narrow. */
function quantity(item: DraftItem | null): string {
  if (!item) return "—";
  const unit = item.unitLabel?.trim() ?? "";
  if (!unit || unit === "each" || unit === "visit" || unit === "fixed fee") return String(item.quantity);
  if (unit === "linear ft") return `${item.quantity} ft`;
  if (unit === "box") return `${item.quantity} ${item.quantity === 1 ? "box" : "boxes"}`;
  return `${item.quantity} ${unit}`;
}

/** "Back bar wall tile → sage green" when the new name extends the old one. */
function changeName(change: DraftChange): string {
  const { before, after } = change;
  if (!before || !after || before.name === after.name) return (after ?? before)?.name ?? "Line";
  return after.name.startsWith(`${before.name}, `) ? `${before.name} → ${after.name.slice(before.name.length + 2)}` : `${before.name} → ${after.name}`;
}

/** Which change each question to check is about, by its row; null for a question that stands on its own. */
function questionRows(questions: readonly string[], changes: readonly DraftChange[]): (number | null)[] {
  return questions.map((question) => matchQuestion(question, changes.map(changeName)));
}

function Mark({ n }: { n: number }) {
  return <span aria-label={`Check ${n}`} className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 align-[1px] text-[10px] font-bold text-white first:ml-0">{n}</span>;
}

function Chip({ className, children }: { className: string; children: string }) {
  return <span className={`ml-1.5 inline-block whitespace-nowrap rounded-[5px] px-1.5 py-px align-[1px] text-[10px] font-bold tracking-[0.02em] ${className}`}>{children}</span>;
}

/** A cell's new value; when it changed, the old one struck through above it and the new one marked, as in the quote editor. */
function Value({ was, now }: { was: string | null; now: string | null }) {
  if (now === null) return <span className="text-[var(--muted)] line-through">{was ?? "—"}</span>;
  if (was === null || was === now) return <span>{now}</span>;
  return <span className="inline-grid justify-items-end"><span className="text-[10.5px] leading-[1.1] text-[var(--muted)] line-through">{was}</span><span className="rounded-[5px] bg-[#fff3c4] px-1.5">{now}</span></span>;
}

/**
 * The draft in Setti's reply, as the designer reads it in the chat: one row per
 * changed line with what changed and by how much, a non-refundable fee in the
 * line it comes from, the quote total, and what to check before pricing. Every
 * figure comes from the draft and the pricing rules, not from the model's words.
 */
export function DraftMessageCard({ draft, projectKey, projectName }: { draft: ChangeDraft; projectKey: CaseKey; projectName: string }) {
  const [estimate, setEstimate] = useState<DraftEstimate | null>(null);
  const [client, setClient] = useState<string | null>(null);
  const { id, revision } = draft;
  useEffect(() => {
    let live = true;
    fetch(`/api/pricing/${projectKey}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<PricingWorkspace> : null)
      .then((workspace) => { if (live && workspace) { setEstimate(draftEstimate(workspace, { id, revision })); setClient(workspace.quote.clientName || null); } })
      .catch(() => { /* the card shows the draft's own subtotals */ });
    return () => { live = false; };
  }, [projectKey, id, revision]);

  const count = draft.changes.length;
  const marks = questionRows(draft.unresolved, draft.changes);
  const markOf = (index: number) => marks.indexOf(index) + 1;
  const before = draft.changes.reduce((sum, change) => sum + (change.beforeSubtotalCents ?? 0), 0);
  const after = draft.changes.reduce((sum, change) => sum + (change.afterSubtotalCents ?? 0), 0);
  const feeTotal = estimate?.fees.reduce((sum, fee) => sum + fee.cents, 0) ?? 0;
  // Whole dollars when every amount is whole, as a quote reads.
  const amounts = draft.changes.flatMap((change) => [change.before?.unitPriceCents, change.after?.unitPriceCents, change.beforeSubtotalCents, change.afterSubtotalCents, change.deltaSubtotalCents])
    .concat((estimate?.fees ?? []).map((fee) => fee.cents)).filter((value): value is number => typeof value === "number");
  const whole = amounts.every((value) => value % 100 === 0);
  const money = (cents: number) => whole ? `$${(cents / 100).toLocaleString("en-US")}` : usd(cents);
  const signed = (cents: number) => `${cents < 0 ? "−" : "+"}${money(Math.abs(cents))}`;
  const price = (cents: number | null) => cents === null ? "To review" : money(cents);
  const loose = draft.unresolved.map((question, index) => ({ question, n: index + 1 })).filter((_, index) => marks[index] === null);
  const th = "whitespace-nowrap border-b border-[var(--line)] px-2 py-2 text-[10.5px] font-semibold tracking-[0.02em] text-[var(--muted)]";
  const td = "whitespace-nowrap border-b border-[var(--line)] px-2 py-[7px] text-right align-middle";

  return <div className="mt-2 overflow-hidden rounded-xl border border-[var(--line)] bg-white text-[12px]">
    <div className="flex items-start gap-2.5 px-4 pb-2.5 pt-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--primary)]"><FileText className="h-4 w-4" /></span>
      <span className="min-w-0"><span className="block text-[13px] font-semibold">Draft · {count} {count === 1 ? "change" : "changes"} to V{draft.basedOnVersion}</span>
        <span className="block text-[11px] text-slate-500">{projectName} · nothing goes to {client ?? "the client"} until you send it</span></span>
    </div>
    <div className="overflow-x-auto px-2">
      <table className="w-full min-w-[520px] border-collapse text-[12.5px] tabular-nums">
        <thead><tr><th className={`${th} text-left`}>Item</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Unit price</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>Change</th></tr></thead>
        <tbody>{draft.changes.map((change, index) => {
          const fees = (estimate?.fees ?? []).filter((fee) => fee.itemId !== null && fee.itemId === change.itemId);
          const questions = draft.unresolved.map((question, at) => ({ question, n: at + 1 })).filter((_, at) => marks[at] === index);
          const delta = change.deltaSubtotalCents;
          const removed = !change.after;
          return <Fragment key={`${change.itemId ?? "new"}-${index}`}>
            <tr>
              <td className="border-b border-[var(--line)] px-2 py-[7px] align-middle">
                <span className={`font-semibold ${removed ? "text-[var(--muted)] line-through" : ""}`}>{changeName(change)}</span>
                {change.action === "add" && <Chip className="bg-[#eef6ff] text-[#1d4f91]">NEW</Chip>}
                {removed && <Chip className="bg-[#fdf1f0] text-[#9c3d34]">REMOVED</Chip>}
                {markOf(index) > 0 && <Mark n={markOf(index)} />}
              </td>
              <td className={td}><Value was={change.before ? quantity(change.before) : null} now={change.after ? quantity(change.after) : null} /></td>
              <td className={td}><Value was={change.before ? price(change.before.unitPriceCents) : null} now={change.after ? price(change.after.unitPriceCents) : null} /></td>
              <td className={td}><Value was={change.before && change.beforeSubtotalCents !== null ? money(change.beforeSubtotalCents) : null} now={change.after && change.afterSubtotalCents !== null ? money(change.afterSubtotalCents) : null} /></td>
              <td className={`${td} font-semibold ${delta === null ? "" : delta < 0 ? "text-[#047857]" : delta > 0 ? "text-[#9c3d34]" : ""}`}>{delta === null ? "To review" : signed(delta)}</td>
            </tr>
            {fees.map((fee) => <tr key={fee.label}>
              <td colSpan={4} className="border-b border-dashed border-[var(--line)] px-2 pb-1.5 pt-1"><span className="flex flex-wrap items-center gap-1.5 pl-3.5 text-[12px] text-slate-600">{fee.label}<span className="rounded-full bg-[#fdeceb] px-[7px] py-px text-[10px] font-bold text-[#9c3d34]">Not refundable</span></span></td>
              <td className="whitespace-nowrap border-b border-dashed border-[var(--line)] px-2 pb-1.5 pt-1 text-right font-semibold text-[#9c3d34]">{signed(fee.cents)}</td>
            </tr>)}
            {questions.map(({ question, n }) => <tr key={n}><td colSpan={5} className="border-b border-[var(--line)] bg-[#fffbeb] px-2 py-1.5 text-[12px] text-[#92400e]"><span className="flex items-start gap-2 pl-3.5"><Mark n={n} />{question}</span></td></tr>)}
          </Fragment>;
        })}</tbody>
      </table>
    </div>
    <div className="mx-4 flex items-baseline gap-3 border-t-2 border-[var(--ink)] py-2.5 tabular-nums">
      <span className="flex-1 text-[13px] font-semibold">Quote total</span>
      {estimate ? <><span className="text-[12px] text-[var(--muted)]">{money(estimate.baseline)} → {money(estimate.total)}</span><b className="text-[13px] font-bold">{signed(estimate.difference)}</b></>
        : <b className="text-[13px] font-bold">{signed(after - before)}</b>}
    </div>
    {feeTotal > 0 && <p className="-mt-1.5 px-4 pb-2.5 text-right text-[11px] text-[var(--muted)]">Includes {money(feeTotal)} in fees that can&apos;t be refunded.</p>}
    {loose.length > 0 && <div className="border-t border-[var(--line)] bg-[#fffbeb] px-4 py-2.5 text-[12px] text-[#92400e]">
      <p className="font-semibold">Check before pricing</p>
      <ol className="mt-1 grid gap-1">{loose.map(({ question, n }) => <li key={n} className="flex items-start gap-2"><Mark n={n} />{question}</li>)}</ol>
    </div>}
    <div className="flex justify-end border-t border-[var(--line)] px-4 py-2.5">
      <Link href={quoteHref(projectKey)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">Open the quote<ArrowRight className="h-3.5 w-3.5" /></Link>
    </div>
  </div>;
}
