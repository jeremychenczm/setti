"use client";

import { ArrowDownRight, ArrowUpRight, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { shortMoney } from "./common";
import { useCounted } from "./MoneyCard";
import { SumCard } from "./EditorFrame";

const OLD = "#a9a597", UP = "#ffcc70", DOWN = "#b7d7c4", PRODUCT = "#d7262e", SERVICE = "#ffcc70";

function Big({ cents }: { cents: number | null }) {
  const shown = useCounted(cents ?? 0);
  return <b className="text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums">{cents === null ? "—" : shortMoney(shown)}</b>;
}

function Bar({ parts, label }: { parts: { cents: number; color: string; striped?: boolean }[]; label: string }) {
  const whole = parts.reduce((sum, part) => sum + part.cents, 0);
  return <div role="img" aria-label={label} className="flex h-2.5 overflow-hidden rounded-full bg-[#ebe9e2]">
    {parts.map((part, index) => <i key={index} className="block h-full transition-[width] duration-500" style={{ width: `${whole ? (part.cents / whole) * 100 : 0}%`, background: part.striped ? `repeating-linear-gradient(135deg, ${part.color} 0 4px, #ffffff 4px 7px)` : part.color }} />)}
  </div>;
}

function Key({ color, label, value, striped }: { color: string; label: string; value: string; striped?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: striped ? `repeating-linear-gradient(135deg, ${color} 0 2px, #ffffff 2px 4px)` : color }} />{label} <b className="font-semibold text-[var(--ink)]">{value}</b></span>;
}

/**
 * A change's total: the new total large, how far it moved from the signed
 * version, and a bar of how much of it was already agreed and how much is new
 * (or, for a smaller version, what was taken out). The editor's Total card and
 * a sent version's summary show the same figures.
 */
export function ChangeTotalFigures({ baseVersion, version, previousCents, nextCents, keptCents, note }: {
  baseVersion: number; version: number | null; previousCents: number | null; nextCents: number | null; keptCents: number; note: string;
}) {
  const delta = previousCents !== null && nextCents !== null ? nextCents - previousCents : null;
  const up = (delta ?? 0) >= 0;
  const kept = Math.min(previousCents ?? 0, nextCents ?? 0);
  return <div className="grid content-start gap-3">
    <div className="grid gap-1.5">
      <span className="text-[11.5px] font-semibold text-[var(--muted)]">V{version} total</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><Big cents={nextCents} />
        {delta !== null && delta !== 0 && <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-bold tabular-nums ${up ? "bg-[#fdeceb] text-[#9c3d34]" : "bg-emerald-50 text-emerald-700"}`}>{up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{up ? "+" : "−"}{shortMoney(Math.abs(delta))}</span>}</span>
      <span className="text-[12px] text-[var(--muted)]">V{baseVersion}, signed: <span className="tabular-nums">{previousCents === null ? "—" : shortMoney(previousCents)}</span></span>
    </div>
    {delta !== null && <>
      <Bar label={`Of ${shortMoney(Math.max(previousCents ?? 0, nextCents ?? 0))}: ${shortMoney(kept)} unchanged from V${baseVersion}, ${up ? "added" : "taken out"} ${shortMoney(Math.abs(delta))}`}
        parts={[{ cents: kept, color: OLD }, { cents: Math.abs(delta), color: up ? UP : DOWN, striped: !up }]} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--muted)]"><Key color={OLD} label={`From V${baseVersion}`} value={shortMoney(kept)} /><Key color={up ? UP : DOWN} striped={!up} label={up ? "Added" : "Taken out"} value={shortMoney(Math.abs(delta))} /></p>
    </>}
    {keptCents > 0 && <p className="flex items-center gap-2 rounded-lg bg-[#fdf6f5] px-3 py-2 text-[12px] text-[#7a2f28]"><LockKeyhole className="h-3.5 w-3.5 shrink-0" /><span className="flex-1">Kept by the suppliers, not refundable</span><b className="tabular-nums">{shortMoney(keptCents)}</b></p>}
    <p className="text-[11.5px] text-[var(--muted)]">{note}</p>
  </div>;
}

export function ChangeTotalCard({ baseVersion, version, previousCents, nextCents, keptCents, children }: {
  baseVersion: number; version: number | null; previousCents: number | null; nextCents: number | null; keptCents: number; children?: ReactNode;
}) {
  return <SumCard label="Total" first>
    <div className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-[15px] font-bold">Total</h3><span className="rounded-full bg-[var(--canvas)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--muted)]">V{baseVersion} → V{version}</span></div>
      <ChangeTotalFigures baseVersion={baseVersion} version={version} previousCents={previousCents} nextCents={nextCents} keptCents={keptCents} note="The change is not what the client pays today; nothing is held or charged until they sign." />
      {children}
    </div>
  </SumCard>;
}

/** A first quote's total, large, with how it splits between products and services. */
export function FirstTotalCard({ productCents, serviceCents }: { productCents: number; serviceCents: number }) {
  const total = productCents + serviceCents;
  return <SumCard label="Total" first>
    <div className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-2"><h3 className="text-[15px] font-bold">Total</h3><span className="rounded-full bg-[var(--canvas)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--muted)]">V1</span></div>
      <div className="grid gap-1.5"><span className="text-[11.5px] font-semibold text-[var(--muted)]">V1 total</span><Big cents={total} /></div>
      <Bar label={`${shortMoney(productCents)} in products, ${shortMoney(serviceCents)} in services`} parts={[{ cents: productCents, color: PRODUCT }, { cents: serviceCents, color: SERVICE }]} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--muted)]"><Key color={PRODUCT} label="Products" value={shortMoney(productCents)} /><Key color={SERVICE} label="Services" value={shortMoney(serviceCents)} /></p>
      <p className="text-[11.5px] text-[var(--muted)]">When the client signs, the services they approve are paid and the products they approve are held on their card.</p>
    </div>
  </SumCard>;
}
