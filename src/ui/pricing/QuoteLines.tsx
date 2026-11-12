"use client";

import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { nonRefundableText, notRefundedText } from "@/pricing/fees";
import type { FinalQuoteLine, FrozenChangeOrder, OldItemHandling, ReviewedChange } from "@/pricing/types";
import type { ApprovedQuoteLine } from "@/quotes/types";
import { calculateLineTotals } from "@/quotes/totals";
import { ChangeLineButton } from "../quotes/QuoteReport";
import { FromV1Note, money, safeUrl, shortMoney, signedMoney } from "./common";

const handlingLabels: Record<OldItemHandling, string> = { pending: "Not checked", not_ordered: "Not ordered", cancelled: "Cancelled", modified: "Modified", returned: "Returned / return arranged", retained: "Retained", not_applicable: "Not applicable" };

type Priced = Pick<FinalQuoteLine, "quantity" | "unitPriceCents" | "taxCents" | "freightCents"> & { unitLabel?: string };
const total = (line: Priced) => calculateLineTotals(line).totalCents;

/** "16 linear ft", "20 boxes", "12": a quantity in its purchase unit, where "each" goes unsaid. */
function units(quantity: number, unit = "each"): string {
  if (unit === "each") return String(quantity);
  if (quantity === 1) return `1 ${unit}`;
  const words = unit.split(" ");
  const last = words.pop()!;
  const plural = /^(?:ft|in|yd|m|cm|mm|lb|lbs|kg|oz|sf|sq)$/i.test(last) || /\d|s$/i.test(last) ? last
    : /(?:x|z|ch|sh)$/i.test(last) ? `${last}es` : /[^aeiou]y$/i.test(last) ? `${last.slice(0, -1)}ies` : `${last}s`;
  return `${quantity} ${[...words, plural].join(" ")}`;
}

/** "14 × $195", "Fixed fee", plus any tax and delivery the line carries. */
function priced(line: Priced): string {
  const unit = line.unitLabel ?? "each";
  const base = line.quantity === 1 && /\b(?:fee|total)\b/i.test(unit) ? unit.charAt(0).toUpperCase() + unit.slice(1) : `${units(line.quantity, unit)} × ${shortMoney(line.unitPriceCents)}`;
  const extra = line.taxCents + line.freightCents;
  return extra ? `${base} + ${shortMoney(extra)} ${line.taxCents && line.freightCents ? "tax & delivery" : line.taxCents ? "tax" : "delivery"}` : base;
}

const Was = ({ children }: { children: ReactNode }) => <><s className="text-[var(--muted)] decoration-slate-300">{children}</s>{" → "}</>;

interface Row {
  key: string;
  name: string;
  what: ReactNode;
  /** The V2 line; null for a line this version removes. */
  line: FinalQuoteLine | null;
  before: ApprovedQuoteLine | null;
  change: ReviewedChange | null;
  amount: string;
  delta: { text: string; tone: "new" | "up" | "down" | "same" };
}

const deltaTone = { new: "font-semibold text-[var(--primary)]", up: "text-slate-600", down: "text-emerald-700", same: "text-[var(--muted)]" };
const signed = (cents: number): Row["delta"] => cents === 0 ? { text: "No price change", tone: "same" } : { text: signedMoney(cents), tone: cents > 0 ? "up" : "down" };

function changeRow(change: ReviewedChange): Row {
  const { before, after } = change;
  const base = { key: change.key, line: after, before, change };
  if (change.action === "add" && after) {
    const from = change.fromV1 ? change.fromV1.kind === "revised" ? " · revised from V1" : " · carried over from V1" : "";
    return { ...base, name: after.name, what: `${priced(after)}${from}`, amount: money(total(after)), delta: { text: "New", tone: "new" } };
  }
  if (!after && before) return { ...base, name: before.name, what: <><Was>{priced(before)}</Was>removed</>, amount: money(0), delta: signed(-total(before)) };
  if (!after || !before) return { ...base, name: after?.name ?? before?.name ?? change.key, what: "", amount: after ? money(total(after)) : money(0), delta: { text: "", tone: "same" } };
  const samePrice = before.unitPriceCents === after.unitPriceCents && (before.unitLabel ?? "each") === after.unitLabel;
  const was = change.action === "replace" ? `${before.name}, ${priced(before)}` : samePrice && before.quantity !== after.quantity ? String(before.quantity) : priced(before);
  return { ...base, name: after.name, what: <><Was>{was}</Was>{priced(after)}</>, amount: money(total(after)), delta: signed(total(after) - total(before)) };
}

/** What the client reads when a line opens: the product, its terms and the evidence for its price. */
function Details({ row, onChangeLine }: { row: Row; onChangeLine?: (itemId: string) => Promise<void> }) {
  const { line, before, change } = row;
  const item = line ?? before!;
  const strict = line ? line.customMade || line.returnable === false : !!before && (before.customMade || before.nonReturnable === true);
  const source = safeUrl(line ? line.sourceUrl : before?.source.url);
  return <div className="mb-3 ml-6 grid gap-1.5 rounded-lg bg-[var(--canvas)] px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">
    <p>{[item.specification, item.vendor].filter(Boolean).join(" · ")}</p>
    <p className="text-[11px] text-[var(--muted)]">{[item.sku, item.room, line?.brand ? `Brand ${line.brand}` : null].filter(Boolean).join(" · ")}</p>
    {change?.fromV1 && <FromV1Note fromV1={change.fromV1} changes={change.changesFromV1} listChanges />}
    {item.returnPolicy && <p className={`whitespace-pre-wrap ${strict ? "text-amber-800" : ""}`}><span className="font-medium">Returns: </span>{item.returnPolicy}</p>}
    {change && change.oldItemHandling !== "not_applicable" && <div className="text-amber-800"><p><span className="font-medium">Old item: {handlingLabels[change.oldItemHandling]}.</span> {notRefundedText(change)}.</p>{change.oldItemNote && <p className="whitespace-pre-wrap">{change.oldItemNote}</p>}</div>}
    {change?.priceEvidence && <p className="whitespace-pre-wrap text-[11px]"><span className="font-medium text-slate-700">Price evidence: </span>{change.priceEvidence}</p>}
    {source && <a href={source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 justify-self-start text-[11px] text-[var(--primary)] underline">View price source<ArrowUpRight className="h-3 w-3" /></a>}
    {onChangeLine && line && <ChangeLineButton onChange={() => onChangeLine(line.itemId)} />}
  </div>;
}

const grid = "grid grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-1 px-0.5 py-2.5";

function Line({ name, what, amount, delta, muted = false, strong = false }: { name: string; what?: ReactNode; amount: string; delta: Row["delta"]; muted?: boolean; strong?: boolean }) {
  return <>
    <span className="grid min-w-0 gap-px"><span className={`line-name ${strong ? "text-[14px] font-bold" : muted ? "text-[13px] font-medium text-[var(--muted)]" : "text-[13px] font-semibold"}`}>{name}</span>{what && <span className={muted ? "text-[var(--muted)]" : "text-slate-600"}>{what}</span>}</span>
    <span className="grid justify-items-end gap-px"><span className={`whitespace-nowrap text-right ${strong ? "text-[14px] font-bold" : muted ? "text-[13px] font-medium text-[var(--muted)]" : "text-[13px] font-semibold"}`}>{amount}</span><span className={`text-[11px] ${deltaTone[delta.tone]}`}>{delta.text}</span></span>
  </>;
}

/**
 * The whole proposed quote as one list: each line with what changed, its new
 * amount and the difference from the confirmed version, then the old items'
 * non-refundable fees and the total. A line opens to its terms.
 */
/** `folded`: the list waits behind one summary line, as on the designer's payment page. */
export function QuoteLines({ order, onChangeLine, lineError, folded = false }: { order: FrozenChangeOrder; onChangeLine?: (itemId: string) => Promise<void>; lineError?: string | null; folded?: boolean }) {
  const rows: Row[] = [
    ...order.changes.map(changeRow),
    ...order.lines.filter((line) => line.origin === "unchanged").map((line): Row => ({
      key: `line:${line.itemId}`, name: line.name, what: priced(line), line, before: null, change: null, amount: money(total(line)), delta: { text: "Unchanged", tone: "same" },
    })),
  ];
  const fees = order.lines.filter((line) => line.origin === "old_item_cost");
  const feeCents = fees.reduce((sum, line) => sum + total(line), 0);
  const feeNames = order.changes.filter((change) => change.oldItemCostCents > 0).map((change) => `${change.before?.name ?? "Old item"}: ${nonRefundableText(change)}`);
  const summary = `${grid} cursor-pointer list-none rounded-md [&::-webkit-details-marker]:hidden [&:hover_.line-name]:text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]`;

  const list = <>
    <ul className="border-t border-[var(--line)] text-[12px] tabular-nums">
      {rows.map((row) => <li key={row.key} className="border-b border-[var(--line)]"><details className="group">
        <summary className={summary}><ChevronRight aria-hidden className="h-3 w-3 self-center text-[var(--muted)] transition-transform group-open:rotate-90 motion-reduce:transition-none" /><Line name={row.name} what={row.what} amount={row.amount} delta={row.delta} muted={!row.change} /></summary>
        <Details row={row} onChangeLine={onChangeLine} />
      </details></li>)}
      {fees.length > 0 && <li className={`${grid} border-b border-[var(--line)] bg-brand-50`}><span /><Line name="Fees on the old items" what={`${feeNames.join(" · ")} · can't be refunded`} amount={money(feeCents)} delta={{ text: signedMoney(feeCents), tone: "up" }} /></li>}
      <li className={grid}><span /><Line name="Total" amount={money(order.totals.totalCents)} delta={{ text: `${signedMoney(order.deltaTotalCents)} vs V${order.basedOnVersion}`, tone: "up" }} strong /></li>
    </ul>
    {lineError && <p role="alert" className="mt-2 text-[11px] text-red-700">{lineError}</p>}
  </>;
  if (folded) return <details className="group/quote mb-5 rounded-xl bg-white shadow-sm">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl px-5 py-4 text-[13px] font-semibold [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)] sm:px-6"><ChevronRight aria-hidden className="h-3.5 w-3.5 text-[var(--muted)] transition-transform group-open/quote:rotate-90 motion-reduce:transition-none" />Quote V{order.version}<span className="font-normal text-[var(--muted)]">{rows.length} lines · {money(order.totals.totalCents)}</span></summary>
    <div className="px-5 pb-5 sm:px-6">{list}</div>
  </details>;
  return <section className="mb-5 rounded-xl bg-white p-5 shadow-sm sm:p-6" aria-labelledby="quote-lines-title">
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3"><h2 id="quote-lines-title" className="text-[13px] font-semibold">Quote V{order.version}</h2><span className="text-[11px] text-[var(--muted)]">V{order.version} amount · vs V{order.basedOnVersion}</span></div>
    {list}
  </section>;
}
