"use client";

import { ArrowUpRight, ChevronRight, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { CaseMessage, ChangeDraft, DraftChange, DraftItem } from "@/chat/types";
import { FromV1Note } from "../pricing/common";
import type { DraftEstimate } from "./draft-pricing";

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "Price to review";
  if (!currency) return `${(cents / 100).toFixed(2)} · currency to confirm`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export const signedUsd = (cents: number) => `${cents < 0 ? "−" : "+"}${usd(Math.abs(cents))}`;

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export const Was = ({ children }: { children: ReactNode }) => <span className="text-slate-400 line-through decoration-slate-300">{children}</span>;
export const Act = ({ children }: { children: ReactNode }) => <span className="text-[var(--muted)]">{children} · </span>;

/** A line's amount difference, or what is still missing; a decrease reads as a credit. */
export function Amount({ cents }: { cents: number | null }) {
  if (cents === null) return <span className="text-[12px] font-medium text-amber-700">Price to review</span>;
  return <span className={`whitespace-nowrap text-[13px] font-semibold tabular-nums ${cents < 0 ? "text-emerald-700" : ""}`}>{signedUsd(cents)}</span>;
}

/** One line of a draft or a saved review: what changed and what it does to the total; its details open below. */
export function ChangeRow({ name, what, side, open = false, children }: { name: string; what: ReactNode; side: ReactNode; open?: boolean; children?: ReactNode }) {
  return <li className="border-b border-[var(--line)]">
    <details open={open} className="group">
      <summary className="grid cursor-pointer list-none grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-0.5 rounded-md px-0.5 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary-fill)] [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="h-3 w-3 self-center text-[var(--muted)] transition-transform group-open:rotate-90" />
        <span className="min-w-0"><span className="block text-[13px] font-semibold group-hover:text-[var(--primary)]">{name}</span><span className="block text-[12px] leading-relaxed text-slate-600">{what}</span></span>
        <span className="flex flex-col items-end gap-0.5 text-right">{side}</span>
      </summary>
      {children && <div className="mb-3 ml-6 space-y-1.5 rounded-lg bg-[var(--canvas)] px-3 py-2.5 text-[12px] leading-relaxed text-slate-600">{children}</div>}
    </details>
  </li>;
}

/** A section heading with the column the rows' right side shows. */
export function RowsHeading({ children, side }: { children: ReactNode; side: string }) {
  return <p className="mb-0.5 flex justify-between gap-3 text-[12px] font-semibold text-slate-600">{children}<span className="font-normal text-[var(--muted)]">{side}</span></p>;
}

/** A collapsed extra at the bottom of the dialog. */
export function Fold({ title, count, children }: { title: string; count: string; children: ReactNode }) {
  return <details className="group border-b border-[var(--line)]">
    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-0.5 py-2.5 text-[12px] font-medium [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden className="h-3 w-3 text-[var(--muted)] transition-transform group-open:rotate-90" />{title}<span className="font-normal text-[var(--muted)]">{count}</span></summary>
    <div className="mb-3 ml-6">{children}</div>
  </details>;
}

/** Old value, new value and the total's change, in one line. */
export function TotalsLine({ from, to, delta }: { from: number; to: number | null; delta: number | null }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 tabular-nums">
    <span className="text-[15px] text-[var(--muted)]">{usd(from)}</span><span className="text-[var(--muted)]">→</span>
    <span className="text-[22px] font-bold tracking-tight">{to === null ? "Not priced" : usd(to)}</span>
    {delta !== null && <span className="rounded-full border border-[var(--primary-line)] bg-brand-50 px-2.5 py-px text-[13px] font-semibold text-[var(--primary)]">{signedUsd(delta)}</span>}
  </div>;
}

/** "16 × $210.00 per linear ft": the unit follows the price, so no plural is needed. */
const per = (item: DraftItem) => `${item.quantity} × ${money(item.unitPriceCents, item.currency)}${item.unitLabel && item.unitLabel !== "each" ? ` per ${item.unitLabel}` : ""}`;

/** The change in a few words: what was there and what replaces it. */
function changeText(change: DraftChange): ReactNode {
  const { before, after } = change;
  if (!after) return before ? <><Act>Removed</Act>{per(before)}</> : "Removed";
  if (!before) return <><Act>Added</Act>{per(after)}</>;
  if (change.action === "quantity") return <><Act>Quantity</Act><Was>{before.quantity}</Was> → {per(after)}</>;
  return <><Act>{before.name === after.name ? "Changed" : `Replaces ${before.name}`}</Act><Was>{per(before)}</Was> → {per(after)}</>;
}

function ItemFacts({ item }: { item: DraftItem }) {
  return <>
    {item.specification && <p>{item.specification}</p>}
    <p className="text-[var(--muted)]">{[item.vendor, item.brand && `Brand ${item.brand}`, item.sku].filter(Boolean).join(" · ")}</p>
  </>;
}

/** What the draft sets out to change, as the AI proposed it, before any pricing review. */
export function DraftCard({ draft, messages, onSourceMessage, estimate = null, clientName = null, notice = null }: { draft: ChangeDraft; messages: CaseMessage[]; onSourceMessage: (id: string) => void; estimate?: DraftEstimate | null; clientName?: string | null; notice?: ReactNode }) {
  const sourceIds = [...new Set([...draft.sourceMessageIds, ...draft.changes.flatMap((change) => change.sourceMessageIds)])];
  const count = draft.changes.length;
  const fees = estimate?.fees.reduce((sum, fee) => sum + fee.cents, 0) ?? 0;
  const client = clientName ?? "the client";
  return (
    <article className="space-y-5 p-5 text-[12px]">
      {notice}
      {estimate ? <div className="space-y-2">
        <TotalsLine from={estimate.baseline} to={estimate.total} delta={estimate.difference} />
        <p className="text-[var(--muted)]">Approved V{draft.basedOnVersion} → this draft. Not priced yet: Review pricing checks every price before anything goes to {client}.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums text-slate-600">
          <span>{count} {count === 1 ? "change" : "changes"} <b className="font-semibold text-[var(--ink)]">{signedUsd(estimate.difference - fees)}</b></span>
          {fees > 0 && <span>Fees that can&apos;t be refunded <b className="font-semibold text-[var(--ink)]">{signedUsd(fees)}</b> <span className="text-[11px] text-[var(--muted)]">({estimate.fees.map((fee) => `${fee.name} ${usd(fee.cents)}`).join(", ")})</span></span>}
        </div>
      </div> : <div className="space-y-1.5">
        {draft.deltaSubtotalCents !== null && <p className="text-[22px] font-bold tabular-nums tracking-tight">{signedUsd(draft.deltaSubtotalCents)}</p>}
        <p className="text-[var(--muted)]">{draft.deltaSubtotalCents !== null ? `Subtotal change against approved V${draft.basedOnVersion}, before tax, delivery and any return costs. ` : ""}Not priced yet: Review pricing works out the totals before anything goes to {client}.</p>
      </div>}

      {draft.unresolved.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-950">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800"><CircleAlert className="h-3.5 w-3.5" />{draft.unresolved.length} {draft.unresolved.length === 1 ? "thing" : "things"} to check</h3>
        <ol className="mt-1.5 list-decimal space-y-1 pl-4 leading-relaxed">{draft.unresolved.map((question, index) => <li key={index}>{question}</li>)}</ol>
      </div>}

      <section>
        <RowsHeading side="Difference">{count} {count === 1 ? "change" : "changes"}</RowsHeading>
        <ul className="border-t border-[var(--line)]">{draft.changes.map((change, index) => {
          const item = change.after ?? change.before;
          return <ChangeRow key={`${change.itemId ?? "new"}-${index}`} name={item?.name ?? "Line"} what={changeText(change)} side={<Amount cents={change.deltaSubtotalCents} />}>
            <FromV1Note fromV1={change.fromV1} changes={[]} />
            {item && <ItemFacts item={item} />}
            {change.sourceMessageIds.length > 0 && <p className="flex flex-wrap gap-x-3 gap-y-1">From the chat:{change.sourceMessageIds.map((id, sourceIndex) => <button key={id} onClick={() => onSourceMessage(id)} className="font-medium text-[var(--primary)] hover:underline">Message {sourceIndex + 1}</button>)}</p>}
          </ChangeRow>;
        })}</ul>
      </section>

      {(draft.constraints.length > 0 || sourceIds.length > 0 || draft.sources.length > 0) && <div className="border-t border-[var(--line)]">
        {draft.constraints.length > 0 && <Fold title="Terms to keep" count={String(draft.constraints.length)}><ul className="list-disc space-y-1 pl-4 leading-relaxed text-slate-600">{draft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></Fold>}
        {(sourceIds.length > 0 || draft.sources.length > 0) && <Fold title="Sources" count={[sourceIds.length && `${sourceIds.length} ${sourceIds.length === 1 ? "message" : "messages"}`, draft.sources.length && `${draft.sources.length} product ${draft.sources.length === 1 ? "source" : "sources"}`].filter(Boolean).join(" · ")}>
          <div className="space-y-2">
            {sourceIds.map((id) => {
              const source = messages.find((message) => message.id === id);
              return <button key={id} onClick={() => onSourceMessage(id)} disabled={!source} className="block w-full rounded-lg bg-[var(--canvas)] p-2 text-left text-[11px] leading-relaxed hover:bg-brand-50 disabled:text-[var(--muted)]"><span className="mb-0.5 block font-medium text-[var(--primary)]">{source ? source.actor === "designer" ? "Designer" : source.actor === "client" ? "Client" : "Setti" : "Message unavailable"}</span><span className="line-clamp-3 whitespace-pre-wrap">{source?.text ?? id}</span></button>;
            })}
            {draft.sources.map((source) => {
              const url = safeUrl(source.url);
              return <details key={source.id} className="rounded-lg border border-[var(--line)] p-2.5"><summary className="cursor-pointer break-words text-[12px] font-medium">{source.title || source.url}</summary><div className="mt-2.5 space-y-2.5 text-[11px] leading-relaxed">
                {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1 break-all text-[var(--primary)] hover:underline">{source.url}<ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0" /></a>}
                <p className="text-[var(--muted)]">{source.url.startsWith("local:") ? "Local sample supplied" : "Retrieved"} {new Date(source.fetchedAt).toLocaleString()}</p>
                {source.error && <p className="rounded-lg bg-amber-50 p-2 text-amber-800">{source.error}</p>}
                {source.products.map((product) => <div key={product.id} className="rounded-lg bg-[var(--canvas)] p-2.5"><p className="font-medium">{product.name}</p><p className="mt-1 text-slate-600">Brand: {product.brand ?? "Not confirmed"} · Seller: {product.seller ?? "Not confirmed"}</p><p className="mt-1 text-slate-600">{product.specification}</p><p className="mt-1">{money(product.unitPriceCents, product.currency)} / {product.unitLabel ?? "unit to confirm"}</p>{product.priceEvidence && <p className="mt-1 text-[var(--muted)]">{product.priceEvidence}</p>}{product.availability && <p className="mt-1 text-[var(--muted)]">{product.availability}</p>}</div>)}
                {source.text && <details><summary className="cursor-pointer text-[var(--primary)]">{source.url.startsWith("local:") ? "Read sample supplier documents" : "Read retrieved text"}</summary><p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--canvas)] p-2 text-[10px] text-slate-600">{source.text}</p></details>}
              </div></details>;
            })}
          </div>
        </Fold>}
      </div>}

      <p className="text-[11px] text-[var(--muted)]">Draft only{draft.model === "designer" ? ", written by the designer" : ""}. Approved V{draft.basedOnVersion} stays as it is until {client} confirms a new version.</p>
    </article>
  );
}
