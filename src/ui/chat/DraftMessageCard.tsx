"use client";

import { ArrowRight, CircleAlert, FileText } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import type { CaseKey, ChangeDraft, DraftChange, DraftItem } from "@/chat/types";
import type { PricingWorkspace } from "@/pricing/types";
import { draftEstimate, type DraftEstimate } from "./draft-pricing";
import { usd } from "./DraftCard";
import { quoteHref } from "@/quotes/links";

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

/**
 * Which change a question to check is about: the one whose name shares the most
 * words with it, when exactly one does and by at least two words. Otherwise the
 * question stands alone rather than pointing at a guessed row.
 */
function questionRows(questions: readonly string[], changes: readonly DraftChange[]): (number | null)[] {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/gu) ?? []);
  return questions.map((question) => {
    const asked = words(question);
    const scores = changes.map((change) => [...words(changeName(change))].filter((word) => asked.has(word)).length);
    const best = Math.max(0, ...scores);
    return best >= 2 && scores.filter((score) => score === best).length === 1 ? scores.indexOf(best) : null;
  });
}

function Mark({ n }: { n: number }) {
  return <span aria-label={`Check ${n}`} className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 align-[1px] text-[10px] font-bold text-white">{n}</span>;
}

/**
 * The draft in Setti's reply, as the designer reads it in the chat: only the
 * changed lines, with their old and new quantities, prices and totals, each
 * non-refundable fee under the line it comes from, the totals, and what to check
 * before pricing. Every figure comes from the draft and the pricing rules, not
 * from the model's words.
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
  // Whole dollars when every amount is whole, so the eight columns fit beside the avatar.
  const amounts = draft.changes.flatMap((change) => [change.before?.unitPriceCents, change.after?.unitPriceCents, change.beforeSubtotalCents, change.afterSubtotalCents, change.deltaSubtotalCents])
    .concat((estimate?.fees ?? []).map((fee) => fee.cents)).filter((value): value is number => typeof value === "number");
  const whole = amounts.every((value) => value % 100 === 0);
  const money = (cents: number) => whole ? `$${(cents / 100).toLocaleString("en-US")}` : usd(cents);
  const signed = (cents: number) => `${cents < 0 ? "−" : "+"}${money(Math.abs(cents))}`;
  const price = (cents: number | null) => cents === null ? "To review" : money(cents);
  const cell = "px-2 py-1.5 text-right tabular-nums whitespace-nowrap";
  const head = "px-2 py-1.5 text-right align-bottom leading-tight";
  const old = `${cell} text-[var(--muted)]`;

  return <div className="mt-2 overflow-hidden rounded-xl border border-[var(--line)] bg-white text-[12px]">
    <div className="flex items-start gap-2.5 px-3.5 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--primary)]"><FileText className="h-4 w-4" /></span>
      <span className="min-w-0"><span className="block text-[13px] font-semibold">Draft · {projectName} · {count} {count === 1 ? "change" : "changes"} to V{draft.basedOnVersion}</span>
        <span className="block text-[11px] text-slate-500">Not priced yet · nothing goes to {client ?? "the client"} until you price and send it</span></span>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse">
        <thead><tr className="bg-[var(--canvas)] text-[10px] font-semibold text-[var(--muted)]">
          <th className="px-2.5 py-1.5 text-left align-bottom">Item</th><th className={head}>Old qty</th><th className={head}>New qty</th><th className={head}>Old unit price</th><th className={head}>New unit price</th><th className={head}>Old total</th><th className={head}>New total</th><th className={head}>Difference</th>
        </tr></thead>
        <tbody>{draft.changes.map((change, index) => {
          const fees = (estimate?.fees ?? []).filter((fee) => fee.itemId !== null && fee.itemId === change.itemId);
          const delta = change.deltaSubtotalCents;
          return <Fragment key={`${change.itemId ?? "new"}-${index}`}>
            <tr className="border-t border-[var(--line)]">
              <td className="px-2.5 py-1.5 font-semibold">{changeName(change)}{change.action === "add" && <span className="ml-1.5 rounded-full border border-[var(--primary-line)] bg-brand-50 px-1.5 text-[9px] font-bold text-[var(--primary)]">NEW</span>}{markOf(index) > 0 && <Mark n={markOf(index)} />}</td>
              <td className={old}>{quantity(change.before)}</td><td className={cell}>{quantity(change.after)}</td>
              <td className={old}>{change.before ? price(change.before.unitPriceCents) : "—"}</td><td className={cell}>{change.after ? price(change.after.unitPriceCents) : "—"}</td>
              <td className={old}>{change.before && change.beforeSubtotalCents !== null ? money(change.beforeSubtotalCents) : "—"}</td><td className={cell}>{change.after && change.afterSubtotalCents !== null ? money(change.afterSubtotalCents) : "—"}</td>
              <td className={`${cell} font-medium ${delta !== null && delta < 0 ? "text-emerald-700" : ""}`}>{delta === null ? "To review" : signed(delta)}</td>
            </tr>
            {fees.map((fee) => <tr key={fee.label} className="bg-[#fbfaf6] text-[11px] text-slate-600">
              <td colSpan={7} className="px-2.5 py-1"><span className="inline-block w-5 text-[var(--muted)]">↳</span>{fee.label}<span className="ml-1.5 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 text-[9.5px] font-semibold text-amber-800">Not refundable</span></td>
              <td className={`${cell} py-1`}>{signed(fee.cents)}</td>
            </tr>)}
          </Fragment>;
        })}</tbody>
      </table>
    </div>
    <div className="grid border-t border-[var(--line)] px-3.5 pb-2.5 pt-1 tabular-nums">
      <p className="grid grid-cols-[minmax(0,1fr)_auto_96px] items-baseline gap-x-4 py-1"><span className="text-slate-600">Changed lines</span><span className="text-right text-[var(--muted)]">{money(before)} → {money(after)}</span><b className="text-right font-semibold">{signed(after - before)}</b></p>
      {feeTotal > 0 && <p className="grid grid-cols-[minmax(0,1fr)_auto_96px] items-baseline gap-x-4 py-1"><span className="text-slate-600">Fees that can&apos;t be refunded</span><span className="text-right text-[var(--muted)]">{estimate!.fees.map((fee) => `${fee.label.toLowerCase()} ${money(fee.cents)}`).join(" + ")}</span><b className="text-right font-semibold">{signed(feeTotal)}</b></p>}
      {estimate && <p className="mt-1 grid grid-cols-[minmax(0,1fr)_auto_96px] items-baseline gap-x-4 border-t-2 border-[var(--ink)] pt-2 text-[13px]"><span className="font-semibold">Quote total</span><span className="text-right font-medium">{money(estimate.baseline)} → {money(estimate.total)}</span><b className="text-right font-bold text-[var(--primary)]">{signed(estimate.difference)}</b></p>}
    </div>
    {draft.unresolved.length > 0 && <div className="mx-3.5 mb-3 grid gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800"><CircleAlert className="h-3.5 w-3.5" />Check before pricing</p>
      <ol className="grid gap-2">{draft.unresolved.map((question, index) => {
        const row = marks[index];
        return <li key={index} className="flex items-start gap-2"><span className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">{index + 1}</span>
          <span className="min-w-0">{row !== null && <b className="block text-[12px] font-semibold text-[var(--ink)]">{changeName(draft.changes[row])}</b>}<span className="text-[12px] leading-relaxed text-slate-700">{question}</span></span></li>;
      })}</ol>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] bg-[#fdfcf9] px-3.5 py-2.5">
      <span className="text-[11px] text-[var(--muted)]">Draft only</span>
      <Link href={quoteHref(projectKey)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">Open the quote<ArrowRight className="h-3.5 w-3.5" /></Link>
    </div>
  </div>;
}
