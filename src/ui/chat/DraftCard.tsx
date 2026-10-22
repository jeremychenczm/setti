"use client";

import { ArrowDown, ArrowUpRight, ClipboardCheck, Link2, MessageSquare, ShieldCheck } from "lucide-react";
import type { CaseMessage, ChangeDraft, DraftChange, DraftItem } from "@/chat/types";

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "Price to review";
  if (!currency) return `${(cents / 100).toFixed(2)} · currency to confirm`;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const actionLabel: Record<DraftChange["action"], string> = { quantity: "Quantity change", remove: "Remove", replace: "Replace", add: "Add" };

export function DraftCard({ draft, messages, onSourceMessage, pricingHref, canPrice = false }: { draft: ChangeDraft; messages: CaseMessage[]; onSourceMessage: (id: string) => void; pricingHref?: string; canPrice?: boolean }) {
  const sourceIds = [...new Set([...draft.sourceMessageIds, ...draft.changes.flatMap((change) => change.sourceMessageIds)])];
  return (
    <article className="space-y-5 p-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800">Awaiting designer pricing</span>
          <span className="text-[var(--muted)]">Draft {draft.revision} · based on V{draft.basedOnVersion}</span>
          {draft.changes.length > 1 && <span className="rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-700">{draft.changes.length} changes · one draft</span>}
        </div>
        <h2 className="text-[16px] font-semibold leading-snug">{draft.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{draft.summary}</p>
      </div>

      <div className="space-y-3">
        {draft.changes.map((change, index) => (
          <div key={`${change.itemId ?? "new"}-${index}`} className="rounded-xl border border-[var(--line)] p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-[var(--primary)]">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-50">{index + 1}</span>
              {actionLabel[change.action]}
            </div>
            {change.before && <ItemSummary label={`Approved V${draft.basedOnVersion}`} item={change.before} subtotal={change.beforeSubtotalCents} />}
            {change.before && change.after && <ArrowDown className="my-2 h-3.5 w-3.5 text-[var(--muted)]" />}
            {change.after ? <ItemSummary label="Proposed" item={change.after} subtotal={change.afterSubtotalCents} /> : <p className="mt-2 text-[12px] text-slate-600">Remove this item from the proposed scope.</p>}
            {change.sourceMessageIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--line)] pt-2">{change.sourceMessageIds.map((id, sourceIndex) => <button key={id} onClick={() => onSourceMessage(id)} className="flex items-center gap-1 text-[10px] text-[var(--primary)] hover:underline"><MessageSquare className="h-3 w-3" />Message {sourceIndex + 1}</button>)}</div>}
          </div>
        ))}
      </div>

      {draft.deltaSubtotalCents !== null && <div className="rounded-lg bg-[var(--canvas)] p-3"><div className="flex items-center justify-between gap-3 text-[12px]"><span>Proposed subtotal difference</span><strong>{draft.deltaSubtotalCents >= 0 ? "+" : "−"}{money(Math.abs(draft.deltaSubtotalCents), "USD")}</strong></div><p className="mt-1 text-[10px] leading-relaxed text-[var(--muted)]">Before tax, delivery and any return costs. This is not a payment amount.</p></div>}

      {draft.constraints.length > 0 && <div><h3 className="mb-2 text-[11px] font-semibold text-slate-600">Instructions to preserve</h3><ul className="list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-slate-600">{draft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div>}
      {draft.unresolved.length > 0 && <div className="rounded-xl bg-amber-50 p-3"><h3 className="mb-2 text-[11px] font-semibold text-amber-800">Needs review or clarification</h3><ul className="list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-amber-900">{draft.unresolved.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}

      {sourceIds.length > 0 && <details className="rounded-xl border border-[var(--line)] p-3"><summary className="cursor-pointer text-[12px] font-medium">Source messages · {sourceIds.length}</summary><div className="mt-3 space-y-2">{sourceIds.map((id) => {
        const source = messages.find((message) => message.id === id);
        return <button key={id} onClick={() => onSourceMessage(id)} disabled={!source} className="block w-full rounded-lg bg-[var(--canvas)] p-2 text-left text-[11px] leading-relaxed hover:bg-blue-50 disabled:text-[var(--muted)]"><span className="mb-0.5 block font-medium text-[var(--primary)]">{source ? source.actor === "designer" ? "Designer" : source.actor === "client" ? "Client" : "AI" : "Message unavailable"}</span><span className="line-clamp-3 whitespace-pre-wrap">{source?.text ?? id}</span></button>;
      })}</div></details>}

      {draft.sources.length > 0 && <div><h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-600"><Link2 className="h-3.5 w-3.5" />Product sources · {draft.sources.length}</h3><div className="space-y-2">{draft.sources.map((source) => {
        const url = safeUrl(source.url);
        return <details key={source.id} className="rounded-xl border border-[var(--line)] p-3"><summary className="cursor-pointer break-words text-[12px] font-medium">{source.title || source.url}</summary><div className="mt-3 space-y-3 text-[11px] leading-relaxed">
          {url && <a href={url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1 break-all text-[var(--primary)] hover:underline">{source.url}<ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0" /></a>}
          <p className="text-[var(--muted)]">Retrieved {new Date(source.fetchedAt).toLocaleString()}</p>
          {source.error && <p className="rounded-lg bg-amber-50 p-2 text-amber-800">{source.error}</p>}
          {source.products.map((product) => <div key={product.id} className="rounded-lg bg-[var(--canvas)] p-2.5"><p className="font-medium">{product.name}</p><p className="mt-1 text-slate-600">Brand: {product.brand ?? "Not confirmed"} · Seller: {product.seller ?? "Not confirmed"}</p><p className="mt-1 text-slate-600">{product.specification}</p><p className="mt-1">{money(product.unitPriceCents, product.currency)} / {product.unitLabel ?? "unit to confirm"}</p>{product.priceEvidence && <p className="mt-1 text-[var(--muted)]">{product.priceEvidence}</p>}{product.availability && <p className="mt-1 text-[var(--muted)]">{product.availability}</p>}</div>)}
          {source.text && <details><summary className="cursor-pointer text-[var(--primary)]">Read retrieved text</summary><p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--canvas)] p-2 text-[10px] text-slate-600">{source.text}</p></details>}
        </div></details>;
      })}</div></div>}

      <div className="flex items-start gap-2 rounded-xl bg-blue-50 p-3 text-[11px] leading-relaxed text-blue-800"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>Draft only. A designer must verify the prices and terms of every change before issuing one client version. Approved V{draft.basedOnVersion} stays unchanged.</span></div>
      {pricingHref && <div>{canPrice ? <a href={pricingHref} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2.5 text-[12px] font-medium text-white hover:bg-blue-600"><ClipboardCheck className="h-4 w-4" />Review pricing</a> : <button disabled className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-100 px-4 py-2.5 text-[12px] font-medium text-slate-400"><ClipboardCheck className="h-4 w-4" />Review pricing</button>}<p className="mt-2 text-[10px] leading-relaxed text-slate-400">{canPrice ? "Opens the demo designer’s pricing workspace. Saving and generating a client version are separate steps." : "Available to the designer account while the AI is not running."}</p></div>}
    </article>
  );
}

function ItemSummary({ label, item, subtotal }: { label: string; item: DraftItem; subtotal: number | null }) {
  return <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">{label}</div><p className="text-[12px] font-medium">{item.name}</p><p className="mt-1 text-[11px] leading-relaxed text-slate-600">{item.quantity} {item.unitLabel ?? "units (confirm)"} · {money(item.unitPriceCents, item.currency)} per {item.unitLabel ?? "unit (confirm)"}</p>{item.vendor && <p className="mt-1 text-[11px] text-slate-600">Seller: {item.vendor}</p>}{item.brand && <p className="mt-1 text-[11px] text-slate-600">Brand: {item.brand}</p>}{item.specification && <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{item.specification}</p>}{item.sku && <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">{item.sku}</p>}{subtotal !== null && <p className="mt-1.5 text-[11px] font-medium">Subtotal {money(subtotal, item.currency)}</p>}</div>;
}
