"use client";

import { LoaderCircle, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeskProject, MoneyDesk as Desk } from "@/money-desk/types";
import { deskTotals } from "@/money-desk/types";
import { barScale, defaultSelection, filterCounts, itemBlocks, itemPart, needs, part, PARTS, projectBar, shortUsd, summary, usd, visibleProjects, waterfall, type Block, type DeskFilter, type MoneyPart } from "./desk-view";

const PAYMENT_CHANGED = "setti:payment-changed";
const CARD = "min-w-0 rounded-xl border border-[var(--line)] p-4";

function Swatch({ id, size = 10 }: { id: MoneyPart; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0" style={{ width: size, height: size, background: part(id).fill }} />;
}

function Blocks({ blocks, height, labels }: { blocks: Block[]; height: number; labels: boolean }) {
  return <>{blocks.map((block) => {
    const p = part(block.part);
    return <span key={block.part} className="flex items-center overflow-hidden whitespace-nowrap px-1.5 text-[11px] font-semibold tabular-nums" style={{ flex: `0 0 ${(block.share * 100).toFixed(2)}%`, height, background: p.fill, color: p.ink }}>{labels && block.share > 0.07 ? shortUsd(block.cents) : ""}</span>;
  })}</>;
}

function Waterfall({ project }: { project: DeskProject }) {
  const { steps, total, agreed, peak } = waterfall(project);
  const pct = (cents: number) => `${(cents / peak * 100).toFixed(1)}%`;
  const columns = [...steps.map((step) => ({ label: step.label, value: step.cents ? `${step.sign < 0 ? "−" : "+"}${shortUsd(step.cents)}` : "—", bottom: Math.min(step.from, step.to), height: Math.abs(step.to - step.from), fill: step.cents ? part(step.part).fill : "#ebe9e2", strong: false, outline: false })),
    { label: agreed ? "Agreed" : "Proposed", value: shortUsd(total), bottom: 0, height: total, fill: "#ffffff", strong: true, outline: true }];
  return <>
    <div role="img" aria-label={`${project.name}: ${steps.map((step) => `${step.label} ${usd(step.cents)}`).join(", ")}, ${agreed ? "agreed" : "proposed"} ${usd(total)}`}
      className="mt-5 grid h-[180px] grid-cols-6 items-end gap-1.5 border-b border-[var(--ink)]">
      {columns.map((column) => <div key={column.label} className="relative h-full">
        <span className="absolute left-[12%] right-[12%]" style={{ bottom: pct(column.bottom), height: `max(${pct(column.height)}, 1px)`, background: column.fill, boxShadow: column.outline ? `inset 0 0 0 ${agreed ? 2 : 1}px ${agreed ? "#30362d" : "#d6d1c2"}` : undefined }} />
        <span className={`absolute -left-1.5 -right-1.5 text-center text-[11px] tabular-nums ${column.strong ? "font-bold text-[var(--ink)]" : "font-medium text-slate-600"}`} style={{ bottom: `calc(${pct(column.bottom + column.height)} + 5px)` }}>{column.value}</span>
      </div>)}
    </div>
    <div className="grid grid-cols-6 gap-1.5">{columns.map((column) => <span key={column.label} className="text-center text-[10px] font-medium text-slate-600">{column.label}</span>)}</div>
  </>;
}

/**
 * The designer's money desk: where client money stands in every project, what
 * needs them, and how the selected project's money adds up to its agreement.
 * Every amount comes from Setti's records; nothing here is written by a model.
 */
export function MoneyDesk({ onOpenInbox }: { onOpenInbox: () => void }) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DeskFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/money-desk", { cache: "no-store" });
      if (!response.ok) throw new Error(`The money desk could not be loaded (${response.status}).`);
      setDesk(await response.json() as Desk); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The money desk could not be loaded."); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener(PAYMENT_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener(PAYMENT_CHANGED, refresh); window.removeEventListener("focus", refresh); };
  }, [load]);

  const projects = useMemo(() => desk ? visibleProjects(desk, filter) : [], [desk, filter]);
  const selected = projects.find((project) => project.id === selectedId) ?? projects.find((project) => project.id === defaultSelection(projects)) ?? null;
  const totals = useMemo(() => summary(projects), [projects]);
  const scale = useMemo(() => barScale(projects), [projects]);
  const todo = useMemo(() => needs(projects), [projects]);
  const counts = desk ? filterCounts(desk) : { all: 0, live: 0, example: 0 };
  const projectsLabel = (n: number) => `${n} ${n === 1 ? "project" : "projects"}`;
  const kpis: { id: MoneyPart; label: string; cents: number; n: number; note: string }[] = [
    { id: "held", label: "On hold", cents: totals.heldCents, n: totals.projectsWith.held, note: "Not charged yet" },
    { id: "kept", label: "Charged", cents: totals.chargedCents, n: totals.projectsWith.charged, note: "Captured by PayPal, before refunds" },
    { id: "refunded", label: "Refunded", cents: totals.refundedCents, n: totals.projectsWith.refunded, note: "Returned to clients" },
    { id: "toRefund", label: "Awaiting supplier credit", cents: totals.toRefundCents, n: totals.projectsWith.toRefund, note: "Refund follows the credit" },
  ];

  return <section aria-labelledby="money-title" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-white">
    <header className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] px-5 py-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Wallet className="h-4 w-4" /></span>
      <div className="mr-auto min-w-0">
        <h1 id="money-title" className="text-[15px] font-semibold">Money</h1>
        <p className="text-[11px] text-[var(--muted)]">Where client money stands in every project. Calculated by Setti from the quotes and PayPal Sandbox records.</p>
      </div>
      <div role="group" aria-label="Show projects" className="flex gap-0.5 rounded-[10px] border border-[var(--line)] bg-[var(--canvas)] p-[3px]">
        {(["all", "live", "example"] as const).map((id) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}
          className={`min-h-[30px] rounded-[7px] px-3 text-[12px] font-medium ${filter === id ? "bg-white text-[var(--ink)] shadow-sm" : "text-[var(--muted)]"}`}>
          {id === "all" ? "All" : id === "live" ? "Live" : "Examples"} <span className="ml-0.5 font-normal text-[var(--muted)]">{counts[id]}</span>
        </button>)}
      </div>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
      {error && <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
      {!desk ? <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Reading the payment records…</p> :
      <div className="grid grid-cols-12 gap-3">
        {kpis.map((kpi) => <div key={kpi.id} className={`${CARD} col-span-12 flex flex-col gap-1.5 sm:col-span-6 xl:col-span-3`}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[12px] font-medium text-slate-600"><Swatch id={kpi.id} />{kpi.label}</span>
            <span className="text-[11px] text-slate-400">{projectsLabel(kpi.n)}</span>
          </div>
          <div className="text-[26px] font-semibold tracking-tight tabular-nums">{usd(kpi.cents)}</div>
          <div className="text-[11px] text-[var(--muted)]">{kpi.note}</div>
        </div>)}

        <section aria-label="Projects" className={`${CARD} col-span-12 flex flex-col gap-1 xl:col-span-8`}>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold">Projects</h2>
            <div className="flex flex-wrap">{PARTS.map((p) => <span key={p.id} className="px-2 py-[3px] text-[11px] font-semibold" style={{ background: p.fill, color: p.ink }}>{p.label}</span>)}</div>
          </div>
          {projects.map((project) => {
            const bar = projectBar(project, scale), t = deskTotals(project), on = project.id === selected?.id;
            return <button key={project.id} type="button" aria-pressed={on} onClick={() => setSelectedId(project.id)}
              className={`grid min-h-12 w-full grid-cols-[minmax(120px,200px)_minmax(0,1fr)_110px_30px] items-center gap-3 rounded-lg px-2 py-1 text-left ${on ? "bg-brand-50 shadow-[inset_3px_0_0_var(--primary-fill)]" : "hover:bg-[var(--canvas)]"}`}>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{project.name} <span className={`ml-1 rounded px-1.5 py-px text-[10px] font-medium ${project.source === "live" ? "bg-[var(--agent)] text-slate-600" : "bg-[var(--canvas)] text-[var(--muted)] ring-1 ring-[var(--line)]"}`}>{project.source === "live" ? "Live" : "Example"}</span></span>
                <span className="block truncate text-[11px] text-[var(--muted)]">{project.stage}</span>
              </span>
              <span role="img" aria-label={`${project.name}: ${bar.blocks.map((block) => `${part(block.part).label} ${usd(block.cents)}`).join(", ") || `${usd(project.proposedCents ?? 0)} proposed`}`} className="flex h-[22px] gap-0.5">
                {bar.proposedShare !== null
                  ? <span className="flex items-center px-1.5 text-[11px] text-[var(--muted)] shadow-[inset_0_0_0_1px_#d6d1c2]" style={{ flex: `0 0 ${(bar.proposedShare * 100).toFixed(2)}%` }}>{shortUsd(project.proposedCents ?? 0)} proposed</span>
                  : <Blocks blocks={bar.blocks} height={22} labels />}
              </span>
              <span className="text-right text-[12px] tabular-nums text-[var(--muted)]">{project.agreedCents !== null ? usd(project.agreedCents) : ""}</span>
              {t.needsYou ? <span className="justify-self-end rounded-full bg-[#d7262e] px-1.5 text-center text-[11px] font-semibold text-white">{t.needsYou}</span> : <span />}
            </button>;
          })}
        </section>

        <section aria-label="Needs you" className="col-span-12 flex min-w-0 flex-col gap-1.5 rounded-xl border border-[#f2c9cb] bg-[#fff8f8] p-4 xl:col-span-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Needs you</h2>
            <span className="rounded-full bg-[#d7262e] px-2 py-0.5 text-[11px] font-semibold text-white">{todo.length}</span>
          </div>
          <p className="text-[11px] leading-relaxed text-[var(--muted)]">{todo.length ? `${usd(totals.heldCents)} on hold can be charged once suppliers confirm${totals.toRefundCents ? `; ${usd(totals.toRefundCents)} is refunded after a supplier credit.` : "."}` : "Nothing waits for you right now."}</p>
          <ul className="mt-1">
            {todo.map((row) => <li key={`${row.projectId}:${row.item}`} className="flex items-center gap-2.5 border-t border-[#f6dfe0] py-2">
              <Swatch id={row.part} size={8} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium">{row.item}</span>
                <span className="truncate text-[11px] text-[var(--muted)]">{row.project} · {row.action}</span>
              </span>
              <span className="text-[12px] tabular-nums">{usd(row.amountCents)}</span>
            </li>)}
          </ul>
          <button type="button" onClick={onOpenInbox} className="mt-auto self-start pt-1.5 text-[12px] font-semibold text-[#a3161d] hover:underline">Open in Inbox →</button>
        </section>

        {selected && <>
          <section aria-label={`How ${selected.name} adds up`} className={`${CARD} col-span-12 flex flex-col gap-1.5 xl:col-span-5`}>
            <h2 className="text-[13px] font-semibold">How {selected.name} adds up</h2>
            <p className="text-[11px] text-[var(--muted)]">{selected.agreedCents !== null ? `Charged − refunds + on hold + not funded = agreed ${usd(selected.agreedCents)}` : "Nothing agreed yet; the outline is the proposed quote."}</p>
            <Waterfall project={selected} />
          </section>

          <section aria-label={`Items of ${selected.name}`} className={`${CARD} col-span-12 flex flex-col gap-1.5 xl:col-span-7`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold">{selected.name} <span className="font-normal text-[var(--muted)]">· {selected.stage}</span></h2>
              <a href={selected.href} className="text-[12px] font-semibold text-brand-700 hover:underline">Open payments →</a>
            </div>
            {selected.items.length === 0 ? <p className="mt-1.5 text-[12px] text-[var(--muted)]">No item has money yet. Holds start once {selected.client} approves the quote.</p> :
            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] border-collapse">
                <thead><tr className="text-left text-[11px] text-[var(--muted)]">
                  <th scope="col" className="border-b border-[var(--line)] py-1.5 pr-2 font-medium">Item</th>
                  <th scope="col" className="border-b border-[var(--line)] py-1.5 pr-2 font-medium">Status</th>
                  <th scope="col" className="w-[120px] border-b border-[var(--line)] py-1.5 pr-2 font-medium">Money</th>
                  <th scope="col" className="border-b border-[var(--line)] py-1.5 pl-2 text-right font-medium">Agreed</th>
                  <th scope="col" className="border-b border-[var(--line)] py-1.5 pl-2 text-right font-medium">On hold</th>
                  <th scope="col" className="border-b border-[var(--line)] py-1.5 pl-2 text-right font-medium">Charged</th>
                </tr></thead>
                <tbody>{selected.items.map((item) => {
                  const p = part(itemPart(item)), blocks = itemBlocks(item);
                  return <tr key={item.id} className="text-[12px]">
                    <td className="border-b border-[#f0eee7] py-2 pr-2 font-medium">{item.name}</td>
                    <td className="border-b border-[#f0eee7] py-2 pr-2"><span title={item.next} className="inline-flex rounded-full px-2 py-px text-[11px] font-semibold" style={{ background: p.soft, color: p.softInk }}>{item.status}</span></td>
                    <td className="border-b border-[#f0eee7] py-2 pr-2"><span role="img" aria-label={`${item.name}: ${blocks.map((block) => `${part(block.part).label} ${usd(block.cents)}`).join(", ") || "no money yet"}`} className="flex h-2.5 gap-0.5"><Blocks blocks={blocks} height={10} labels={false} /></span></td>
                    <td className="border-b border-[#f0eee7] py-2 pl-2 text-right tabular-nums">{item.agreedCents ? usd(item.agreedCents) : "—"}</td>
                    <td className="border-b border-[#f0eee7] py-2 pl-2 text-right tabular-nums">{item.heldCents ? usd(item.heldCents) : "—"}</td>
                    <td className="border-b border-[#f0eee7] py-2 pl-2 text-right tabular-nums">{item.chargedCents ? usd(item.chargedCents) : "—"}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
          </section>
        </>}
      </div>}
    </div>
  </section>;
}
