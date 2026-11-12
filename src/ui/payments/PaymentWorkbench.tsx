"use client";

import { Check, CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { FrozenChangeOrder } from "@/pricing/types";
import type { AttentionView } from "@/payments/attention-view";
import type { OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace } from "@/payments/types";
import { nonRefundableText } from "@/pricing/fees";
import { BrandMark } from "../BrandMark";
import { shortMoney } from "../pricing/common";
import { CARD, EditorLayout, GHOST, ModuleTitle, SELECT, SEND, SendBar, SumRow, Todo } from "../pricing/EditorFrame";
import { useCounted } from "../pricing/MoneyCard";
import { useDemoMode } from "../demo-mode";
import { demoSupplierNumber } from "./demo-supplier";
import { lineProgress } from "./progress";

/** Which run a line belongs to: its supplier confirms and it is charged, or the supplier credits it and it is refunded. */
export type BatchMode = "charge" | "refund";
export type BatchResult = { mode: BatchMode } & ({ state: "running" } | { state: "done"; text: string } | { state: "refused"; text: string });
export const lineKey = (line: Pick<PaymentLineView, "side" | "itemId">) => `${line.side}:${line.itemId}`;

const STEPS: Record<BatchMode, PaymentStep["kind"][]> = { charge: ["supplier_confirmation", "capture", "void"], refund: ["supplier_credit", "refund"] };
/** The designer's next step on a line within a run, if it has one now. */
export function nextBatchStep(line: PaymentLineView, mode: BatchMode): PaymentStep | null {
  return line.cancellation ? null : line.steps.find((step) => step.available && step.actor === "designer" && STEPS[mode].includes(step.kind)) ?? null;
}
const toRefund = (line: PaymentLineView) => line.cancellation ? 0 : Math.max(0, line.capturedCents - line.refundedCents - line.targetCents);
const TONES = [{ bg: "#fbf1dc", bar: "#c98a1b" }, { bg: "#e8f0e4", bar: "#5f8a55" }, { bg: "#e6edf6", bar: "#4f74a8" }, { bg: "#eeeaf5", bar: "#7a64a8" }, { bg: "#e2f0ef", bar: "#3f8a85" }, { bg: "#f6e7e1", bar: "#b0654a" }];
const usd = (cents: number) => shortMoney(cents);
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

function Chip({ tone, children }: { tone: "ok" | "warn" | "plain"; children: ReactNode }) {
  const look = tone === "ok" ? "bg-emerald-50 text-emerald-700" : tone === "warn" ? "bg-[#fffbeb] text-[#92400e] shadow-[inset_0_0_0_1px_#fde68a]" : "bg-[#efede6] text-[#4b5348]";
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-[9px] py-0.5 text-[11.5px] font-semibold ${look}`}>{children}</span>;
}

function Tile({ swatch, label, cents, note, striped }: { swatch: string; label: string; cents: number; note: string; striped?: boolean }) {
  const shown = useCounted(cents);
  return <div className="grid gap-px rounded-[10px] bg-[var(--canvas)] px-[11px] py-[9px]">
    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#4b5348]"><i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: striped ? `repeating-linear-gradient(135deg, ${swatch} 0 2px, #fff 2px 4px)` : swatch }} />{label}</span>
    <b className="text-[20px] font-bold tracking-[-0.01em] tabular-nums">{usd(shown)}</b>
    <small className="text-[11px] text-[var(--muted)]">{note}</small>
  </div>;
}

/**
 * The designer's orders and payments on a confirmed version, in the quote editor's
 * table: hold by hold, the supplier's order number and confirmed terms; ticked lines
 * are recorded and charged in one run, and each line is still checked against the
 * signed terms on its own. A confirmation that differs from them is not charged: it
 * starts the next version instead. Credits and refunds work the same way.
 */
export function PaymentWorkbench({ designer, workspace, order, operations, busy, disabled, results, onRun, allItems, head }: {
  designer: boolean; workspace: PaymentsWorkspace; order: FrozenChangeOrder; operations: readonly OperationView[]; busy: string | null; disabled: boolean;
  results: Record<string, BatchResult>; onRun: (batches: { mode: BatchMode; items: { key: string; reference: string }[] }[]) => void; onOpen?: (key: string) => void; allItems: ReactNode;
  /** The page's breadcrumbs and Project info, at the top of the working column. */
  head?: ReactNode;
}) {
  const demo = useDemoMode();
  const lines = workspace.lines;
  // A line stays in its list after a run, so its result shows where it was.
  const charge = lines.filter((line) => nextBatchStep(line, "charge") || results[lineKey(line)]?.mode === "charge");
  const refund = lines.filter((line) => nextBatchStep(line, "refund") || results[lineKey(line)]?.mode === "refund");
  const [tab, setTab] = useState<"charge" | "refund" | "all">(() => charge.length ? "charge" : refund.length ? "refund" : "all");
  const [view, setView] = useState<"supplier" | "status">("supplier");
  const [open, setOpen] = useState(true);
  const [references, setReferences] = useState<Record<string, string>>({});
  // The demo has its supplier numbers filled in, so every line it can record starts ticked.
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const isTicked = (line: PaymentLineView) => ticked[lineKey(line)] ?? demo;
  const [confirmed, setConfirmed] = useState<Record<string, { quantity: number; unitPriceCents: number }>>({});
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [attention, setAttention] = useState<AttentionView | null>(null);
  // Setti's reminders are the studio's; the client never asks for them.
  useEffect(() => {
    if (!designer) return;
    let live = true;
    fetch("/api/attention", { cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<AttentionView> : null).then((view) => { if (live) setAttention(view); }).catch(() => undefined);
    return () => { live = false; };
  }, [workspace, designer]);
  const overdue = new Set((attention?.items ?? []).filter((item) => item.kind === "not_ordered" && item.projectKey === workspace.projectKey).map((item) => `${item.side}:${item.itemId}`));

  const supplierOf = (line: PaymentLineView) => ((line.side === "baseline" ? order.changes.find((change) => change.itemId === line.itemId)?.before?.vendor : undefined)
    ?? order.lines.find((quoteLine) => quoteLine.itemId === line.itemId)?.vendor ?? "Supplier").replace(/\s*\(demo\)$/, "");
  const mode: BatchMode = tab === "refund" ? "refund" : "charge";
  const step = (line: PaymentLineView, kind: PaymentStep["kind"]) => line.steps.find((item) => item.kind === kind);
  const reference = (line: PaymentLineView, kind: BatchMode = mode) => references[lineKey(line)] ?? (demo ? demoSupplierNumber(kind === "refund" ? "credit" : "order", line.itemId, line.label) : "");
  const terms = (line: PaymentLineView) => line.confirmedTerms;
  const typed = (line: PaymentLineView) => confirmed[lineKey(line)] ?? (terms(line) ? { quantity: terms(line)!.quantity, unitPriceCents: terms(line)!.unitPriceCents } : null);
  const differs = (line: PaymentLineView) => { const signed = terms(line), now = typed(line); return !!signed && !!now && signed.purpose === "order" && (now.quantity !== signed.quantity || now.unitPriceCents !== signed.unitPriceCents); };
  const finished = (line: PaymentLineView) => results[lineKey(line)]?.state === "done";
  const runnable = (line: PaymentLineView, kind: BatchMode = mode) => !finished(line) && results[lineKey(line)]?.state !== "running" && !!nextBatchStep(line, kind);
  const canTick = (line: PaymentLineView, kind: BatchMode = mode) => runnable(line, kind) && !!reference(line, kind).trim() && !(kind === "charge" && differs(line));
  const amountOf = (line: PaymentLineView, kind: BatchMode = mode) => finished(line) ? kind === "refund" ? line.refundedCents : line.capturedCents - line.refundedCents
    : kind === "refund" ? step(line, "refund")?.amountCents ?? step(line, "supplier_credit")?.amountCents ?? toRefund(line)
      : step(line, "capture")?.amountCents ?? (terms(line) ? terms(line)!.quantity * terms(line)!.unitPriceCents + terms(line)!.taxCents + terms(line)!.freightCents : 0);
  const releaseOf = (line: PaymentLineView) => mode === "charge" && !finished(line) ? step(line, "void")?.amountCents ?? Math.max(0, line.heldCents - amountOf(line)) : 0;

  const list = tab === "refund" ? refund : charge;
  const running = busy === "batch";
  // One button records everything ticked on both tabs: the supplier orders and their charges first, then the credits and their refunds.
  const chosenFor = (kind: BatchMode) => lines.filter((line) => nextBatchStep(line, kind) && canTick(line, kind) && isTicked(line));
  const orders = chosenFor("charge"), credits = chosenFor("refund");
  const chargeTotal = orders.reduce((sum, line) => sum + amountOf(line, "charge"), 0), refundTotal = credits.reduce((sum, line) => sum + amountOf(line, "refund"), 0);
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  const runLabel = orders.length && credits.length ? `Record ${plural(orders.length, "order")} and ${plural(credits.length, "credit")} · charge ${usd(chargeTotal)}, refund ${usd(refundTotal)}`
    : orders.length ? `Record ${plural(orders.length, "confirmation")} and charge ${usd(chargeTotal)}`
      : credits.length ? `Record ${plural(credits.length, "credit")} and refund ${usd(refundTotal)}` : "Record confirmations and charge";
  const runAll = () => onRun([
    { mode: "charge" as const, items: orders.map((line) => ({ key: lineKey(line), reference: reference(line, "charge") })) },
    { mode: "refund" as const, items: credits.map((line) => ({ key: lineKey(line), reference: reference(line, "refund") })) },
  ].filter((batch) => batch.items.length));
  const tickGroup = (members: PaymentLineView[], value: boolean) => setTicked((current) => ({ ...current, ...Object.fromEntries(members.filter((line) => canTick(line)).map((line) => [lineKey(line), value])) }));

  async function startNext(line: PaymentLineView) {
    const signed = terms(line), now = typed(line);
    if (!signed || !now) return;
    setStarting(lineKey(line)); setStartError(null);
    const response = await fetch(`/api/pricing/${workspace.projectKey}/change-line`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: line.itemId, supplier: { reference: reference(line).trim() || "Supplier confirmation", quantity: now.quantity, unitPriceCents: now.unitPriceCents, taxCents: signed.taxCents, freightCents: signed.freightCents, leadTimeDays: null } }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { href?: string; error?: string } | null;
    if (!response?.ok || !body?.href) { setStarting(null); setStartError(body?.error ?? "The next version could not be started. Try again."); return; }
    window.location.assign(body.href);
  }

  const td = "border-b border-[var(--line)] px-2 py-[7px] align-middle";
  const one = `${td} whitespace-nowrap`;
  const th = "whitespace-nowrap border-b border-[var(--line)] bg-white p-2 text-[10.5px] font-semibold tracking-[0.02em] text-[var(--muted)]";
  const internal = (label: string) => <><EyeOff aria-hidden className="mr-[3px] inline h-3 w-3 align-[-2px]" />{label}<span className="sr-only"> (not shown to the client)</span></>;
  const cellInput = (marked: boolean) => `w-[76px] rounded-md border px-1.5 py-[3px] text-right tabular-nums outline-none focus:border-[#cfcab9] ${marked ? "border-transparent bg-[#fff3c4]" : "border-transparent bg-transparent hover:border-[var(--line)] hover:bg-white"}`;
  const chipOf = (line: PaymentLineView) => line.change === "add" || line.change === "replace" ? <span className="ml-1.5 rounded-[5px] bg-[#eef6ff] px-1.5 py-px text-[10px] font-bold text-[#1d4f91]">New in V{workspace.version}</span>
    : line.change === "remove" ? <span className="ml-1.5 rounded-[5px] bg-[#fdf1f0] px-1.5 py-px text-[10px] font-bold text-[#9c3d34]">Removed in V{workspace.version}</span>
      : line.change === "quantity" ? <span className="ml-1.5 rounded-[5px] bg-[#fff3c4] px-1.5 py-px text-[10px] font-bold text-[var(--primary)]">Changed in V{workspace.version}</span> : null;
  const status = (line: PaymentLineView) => {
    const result = results[lineKey(line)];
    if (result?.state === "running") return <Chip tone="plain"><LoaderCircle className="h-3 w-3 animate-spin" />Working…</Chip>;
    if (result?.state === "done") return <Chip tone="ok"><Check className="h-3 w-3" strokeWidth={3} />{result.text}</Chip>;
    if (result?.state === "refused") return <span title={result.text} className="inline-flex max-w-[220px] items-center gap-1 text-[11.5px] font-medium text-red-700"><CircleAlert className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{result.text}</span></span>;
    if (mode === "charge" && differs(line)) return <Chip tone="warn">Differs from V{workspace.version}</Chip>;
    if (overdue.has(lineKey(line))) return <Chip tone="warn">Held · 3 days passed</Chip>;
    return <Chip tone="plain">{lineProgress(line, operations).label}</Chip>;
  };

  function groupRow(name: string, members: PaymentLineView[], cols: number, sum: number, tone: (typeof TONES)[number]) {
    const tickable = members.filter((line) => canTick(line));
    const count = tickable.filter(isTicked).length;
    return <tr>
      <td colSpan={cols - 2} className="border-b border-[var(--line)] px-2 py-2 font-semibold" style={{ background: tone.bg, boxShadow: `inset 3px 0 0 ${tone.bar}` }}><span className="font-bold">{name}</span><span className="ml-1.5 font-medium text-[var(--muted)]">{members.length} {members.length === 1 ? "item" : "items"}</span></td>
      <td className="border-b border-[var(--line)] px-2 py-2 text-right font-semibold tabular-nums" style={{ background: tone.bg }}>{usd(sum)}</td>
      <td className="border-b border-[var(--line)] px-2 py-2 text-right" style={{ background: tone.bg }}>{tickable.length > 0 && <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]">All<input type="checkbox" checked={count === tickable.length} ref={(input) => { if (input) input.indeterminate = count > 0 && count < tickable.length; }} disabled={disabled} onChange={(event) => tickGroup(members, event.target.checked)} aria-label={`Tick every line in ${name}`} className="h-[15px] w-[15px] cursor-pointer accent-emerald-700" /></label>}</td>
    </tr>;
  }

  function chargeRow(line: PaymentLineView, tone: (typeof TONES)[number], cols: number) {
    const key = lineKey(line), signed = terms(line), now = typed(line), done = finished(line) || !runnable(line), diff = differs(line);
    const stripe = { boxShadow: `inset 3px 0 0 ${tone.bar}` };
    const holds = line.holds.filter((hold) => hold.heldCents > 0);
    const release = releaseOf(line);
    const edit = (field: "quantity" | "unitPriceCents") => {
      if (!signed || !now) return <span className="text-[var(--muted)]">—</span>;
      const value = now[field], was = signed[field];
      if (done || signed.purpose !== "order") return <span>{field === "quantity" ? value : usd(value)}</span>;
      return <>{value !== was && <span className="block text-[10.5px] leading-[1.1] text-[var(--muted)] line-through">{field === "quantity" ? was : usd(was)}</span>}
        <input aria-label={`${line.label} confirmed ${field === "quantity" ? "quantity" : "unit price"}`} inputMode="decimal" disabled={disabled} defaultValue={field === "quantity" ? String(value) : usd(value)} key={`${key}:${field}:${value}`}
          onBlur={(event) => { const n = Number(event.target.value.replace(/[$,\s]/g, "")); if (!Number.isFinite(n) || n <= 0) return; const next = { ...now, [field]: field === "quantity" ? Math.round(n) : Math.round(n * 100) }; setConfirmed((current) => ({ ...current, [key]: next })); if (next[field] !== was) setTicked((current) => ({ ...current, [key]: false })); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className={cellInput(value !== was)} /></>;
    };
    return [<tr key={key} className={done ? "bg-[#fcfcfa]" : undefined}>
      <td style={stripe} className={`${one} w-[22px] pl-2`} />
      <td className={`${td} min-w-[210px]`}><span className="text-[12.5px] font-semibold">{line.label}</span>{chipOf(line)}{signed?.purpose === "retained_cost" && <span className="ml-1.5 rounded-full bg-[#fdeceb] px-[7px] py-px text-[10px] font-bold text-[#9c3d34]">Not refundable</span>}</td>
      {view === "status" && <td className={`${one} text-[var(--muted)]`}>{supplierOf(line)}</td>}
      <td className={`${one} text-right tabular-nums`}>{edit("quantity")}</td>
      <td className={`${one} text-right tabular-nums`}>{edit("unitPriceCents")}</td>
      <td className={`${one} text-right text-[12px] tabular-nums`}>{holds.length ? holds.map((hold) => <span key={hold.id} className="block">{hold.version ? `V${hold.version} ` : ""}{usd(hold.heldCents)}</span>) : <span className="text-[var(--muted)]">—</span>}</td>
      <td className={one}>{done ? <span className="font-mono text-[11px]">{reference(line)}</span> : <input aria-label={`${line.label} supplier order number`} value={reference(line)} placeholder="Add" disabled={disabled} onChange={(event) => setReferences((current) => ({ ...current, [key]: event.target.value }))} className="w-[150px] rounded-md border border-[var(--line)] bg-white px-1.5 py-[3px] font-mono text-[11px] outline-none focus:border-[#cfcab9]" />}</td>
      <td className={one}>{status(line)}</td>
      <td className={`${one} text-right tabular-nums`}><b className="font-semibold">{diff && !done ? "—" : usd(amountOf(line))}</b>{!diff && release > 0 && <span className="block text-[10.5px] text-[var(--muted)]">{usd(release)} released</span>}</td>
      <td className={`${one} text-right`}>{!done && <input type="checkbox" aria-label={`Record ${line.label}`} title={diff ? `Differs from V${workspace.version}: start the next version instead` : reference(line).trim() ? "Record this confirmation" : "Add the supplier order number first"} checked={isTicked(line) && canTick(line)} disabled={disabled || !canTick(line)} onChange={(event) => setTicked((current) => ({ ...current, [key]: event.target.checked }))} className="h-[15px] w-[15px] cursor-pointer accent-emerald-700 disabled:cursor-not-allowed" />}</td>
    </tr>,
    diff && !done && now && signed ? <tr key={`${key}:diff`}><td colSpan={cols} style={stripe} className="border-b border-dashed border-[var(--line)] bg-[#fffbeb] py-[7px] pl-[50px] pr-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#92400e]"><CircleAlert className="h-[15px] w-[15px] shrink-0" />
        <span className="min-w-0 flex-1"><b>{supplierOf(line)} confirmed {now.quantity} × {usd(now.unitPriceCents)} = {usd(now.quantity * now.unitPriceCents)}</b>, not {signed.quantity} × {usd(signed.unitPriceCents)} as {order.clientName.split(" ")[0]} signed in V{workspace.version}. This line is not charged.</span>
        <button type="button" disabled={!!starting} onClick={() => void startNext(line)} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--ink)] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-[#1f241d] disabled:opacity-50">{starting === key ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <BrandMark className="h-3.5 w-3.5" />}Start V{workspace.version + 1} from this confirmation</button>
      </div></td></tr> : null];
  }

  function refundRow(line: PaymentLineView, tone: (typeof TONES)[number]) {
    const key = lineKey(line), done = finished(line) || !runnable(line);
    const kept = line.nonRefundable?.oldItemCostCents ?? 0;
    const fees = line.nonRefundable?.oldItemFees ?? [];
    return <tr key={key} className={done ? "bg-[#fcfcfa]" : undefined}>
      <td style={{ boxShadow: `inset 3px 0 0 ${tone.bar}` }} className={`${one} w-[22px] pl-2`} />
      <td className={`${td} min-w-[210px]`}><span className="text-[12.5px] font-semibold">{line.label}</span>{chipOf(line)}</td>
      <td className={`${one} text-right tabular-nums`}>{usd(line.capturedCents - line.refundedCents + (finished(line) ? line.refundedCents : 0))}</td>
      <td className={td}>{kept > 0 ? <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-slate-600">{fees.length ? nonRefundableText(line.nonRefundable!) : "Kept by the supplier"}<span className="rounded-full bg-[#fdeceb] px-[7px] py-px text-[10px] font-bold text-[#9c3d34]">Not refundable</span><span className="text-[#9c3d34]">−{usd(kept)}</span></span> : <span className="text-[var(--muted)]">—</span>}</td>
      <td className={one}>{done ? <span className="font-mono text-[11px]">{reference(line)}</span> : <input aria-label={`${line.label} credit note number`} value={reference(line)} placeholder="Add" disabled={disabled} onChange={(event) => setReferences((current) => ({ ...current, [key]: event.target.value }))} className="w-[150px] rounded-md border border-[var(--line)] bg-white px-1.5 py-[3px] font-mono text-[11px] outline-none focus:border-[#cfcab9]" />}</td>
      <td className={one}>{status(line)}</td>
      <td className={`${one} text-right font-semibold tabular-nums`}>{usd(amountOf(line))}</td>
      <td className={`${one} text-right`}>{!done && <input type="checkbox" aria-label={`Record ${line.label} credit`} title={reference(line).trim() ? "Record this credit" : "Add the credit note number first"} checked={isTicked(line) && canTick(line)} disabled={disabled || !canTick(line)} onChange={(event) => setTicked((current) => ({ ...current, [key]: event.target.checked }))} className="h-[15px] w-[15px] cursor-pointer accent-emerald-700 disabled:cursor-not-allowed" />}</td>
    </tr>;
  }

  /** Every line of the version and where its money stands; nothing to do here. */
  function allTable() {
    const groups = (["service", "furniture"] as const).map((category) => [category === "service" ? "Services" : "Products", lines.filter((line) => line.category === category)] as const).filter(([, members]) => members.length);
    return <div className="overflow-x-auto [contain:inline-size]"><table className="w-full min-w-[760px] border-collapse text-[12.5px]">
      <thead><tr><th className={th} /><th className={`${th} text-left`}>Item</th><th className={`${th} text-left`}>{internal("Supplier")}</th><th className={`${th} text-right`}>V{workspace.version} total</th><th className={`${th} text-right`}>Paid so far</th><th className={`${th} text-right`}>On hold</th><th className={`${th} text-left`}>Status</th></tr></thead>
      {groups.map(([name, members], index) => { const tone = TONES[index]; return <tbody key={name}>
        <tr><td colSpan={3} className="border-b border-[var(--line)] px-2 py-2" style={{ background: tone.bg, boxShadow: `inset 3px 0 0 ${tone.bar}` }}><span className="font-bold">{name}</span><span className="ml-1.5 font-medium text-[var(--muted)]">{members.length} {members.length === 1 ? "item" : "items"}</span></td>
          <td className="border-b border-[var(--line)] px-2 py-2 text-right font-semibold tabular-nums" style={{ background: tone.bg }}>{usd(members.reduce((sum, line) => sum + line.targetCents, 0))}</td>
          <td className="border-b border-[var(--line)] px-2 py-2 text-right font-semibold tabular-nums" style={{ background: tone.bg }}>{usd(members.reduce((sum, line) => sum + line.capturedCents - line.refundedCents, 0))}</td>
          <td colSpan={2} className="border-b border-[var(--line)] px-2 py-2" style={{ background: tone.bg }} /></tr>
        {members.map((line) => { const progress = lineProgress(line, operations); return <tr key={lineKey(line)}>
          <td style={{ boxShadow: `inset 3px 0 0 ${tone.bar}` }} className={`${one} w-[22px] pl-2`} />
          <td className={`${td} min-w-[210px]`}><span className={`text-[12.5px] font-semibold ${line.cancellation || line.change === "remove" ? "text-[var(--muted)] line-through" : ""}`}>{line.label}</span>{chipOf(line)}</td>
          <td className={`${one} text-[var(--muted)]`}>{supplierOf(line)}</td>
          <td className={`${one} text-right tabular-nums`}>{usd(line.targetCents)}</td>
          <td className={`${one} text-right tabular-nums`}>{usd(line.capturedCents - line.refundedCents)}</td>
          <td className={`${one} text-right tabular-nums`}>{line.heldCents ? usd(line.heldCents) : <span className="text-[var(--muted)]">—</span>}</td>
          <td className={one}><Chip tone={progress.tone === "settled" ? "ok" : overdue.has(lineKey(line)) ? "warn" : "plain"}>{progress.settled && <Check className="h-3 w-3" strokeWidth={3} />}{progress.label}</Chip></td>
        </tr>; })}
      </tbody>; })}
    </table>
    {workspace.others.lineCount > 0 && <p className="border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--muted)]">{workspace.others.lineCount} other lines ({usd(workspace.others.targetCents)}) are outside this change; this page runs no payment step for them.</p>}
    </div>;
  }

  function table() {
    if (tab === "all") return allTable();
    if (!list.length) return <p className="px-4 py-6 text-[12.5px] text-[var(--muted)]">{tab === "charge" ? "No item is waiting for a supplier order or a charge." : "No item is waiting for a supplier credit or a refund."}</p>;
    const cols = tab === "charge" ? (view === "status" ? 10 : 9) : 8;
    const groups: [string, PaymentLineView[]][] = tab === "charge" && view === "status"
      ? ([["Waiting for a supplier order", list.filter((line) => !finished(line))], ["Recorded", list.filter(finished)]] as [string, PaymentLineView[]][]).filter(([, members]) => members.length)
      : [...new Set(list.map(supplierOf))].map((name) => [name, list.filter((line) => supplierOf(line) === name)]);
    const head = tab === "charge"
      ? <tr><th className={th} /><th className={`${th} text-left`}>Item</th>{view === "status" && <th className={`${th} text-left`}>{internal("Supplier")}</th>}<th className={`${th} text-right`}>Confirmed qty</th><th className={`${th} text-right`}>Unit price</th><th className={`${th} text-right`}>On hold</th><th className={`${th} text-left`}>{internal("Supplier order no.")}</th><th className={`${th} text-left`}>Status</th><th className={`${th} text-right`}>Charge</th><th className={`${th} text-right`}>{internal("Record")}</th></tr>
      : <tr><th className={th} /><th className={`${th} text-left`}>Item</th><th className={`${th} text-right`}>Charged</th><th className={`${th} text-left`}>Kept by the supplier</th><th className={`${th} text-left`}>{internal("Credit note no.")}</th><th className={`${th} text-left`}>Status</th><th className={`${th} text-right`}>Refund to {order.clientName.split(" ")[0]}</th><th className={`${th} text-right`}>{internal("Record")}</th></tr>;
    return <div className="overflow-x-auto [contain:inline-size]"><table className="w-full min-w-[860px] border-collapse text-[12.5px]"><thead>{head}</thead>
      {groups.map(([name, members], index) => { const tone = TONES[(index + (tab === "refund" ? 3 : 0)) % TONES.length]; return <tbody key={name}>
        {groupRow(name, members, cols, members.reduce((sum, line) => sum + (tab === "charge" && differs(line) && !finished(line) ? 0 : amountOf(line)), 0), tone)}
        {members.map((line) => tab === "charge" ? chargeRow(line, tone, cols) : refundRow(line, tone))}
      </tbody>; })}
    </table></div>;
  }

  if (!designer) return <>{allItems}</>;
  // What this version asks of the suppliers, read from the records, so a reload or a record made elsewhere counts too.
  const signedOrder = (line: PaymentLineView) => line.supplierEvents.some((event) => event.kind === "order_confirmed" && event.quantity === line.confirmedTerms?.quantity && event.unitPriceCents === line.confirmedTerms?.unitPriceCents);
  const orderScope = lines.filter((line) => line.changed && !line.cancellation && !nextBatchStep(line, "refund") && toRefund(line) === 0 && (!!nextBatchStep(line, "charge") || signedOrder(line)));
  const creditScope = lines.filter((line) => line.changed && !line.cancellation && (!!nextBatchStep(line, "refund") || line.supplierEvents.some((event) => event.kind === "credit_confirmed")));
  const ordersDone = orderScope.filter((line) => !nextBatchStep(line, "charge")).length;
  const creditsDone = creditScope.filter((line) => !nextBatchStep(line, "refund")).length;
  const toOrder = lines.filter((line) => nextBatchStep(line, "charge")).length, toCredit = lines.filter((line) => nextBatchStep(line, "refund")).length;
  // Before a run each item reads how many are ticked to record; once nothing waits, how many were recorded.
  const tickedFor = (kind: BatchMode) => lines.filter((line) => nextBatchStep(line, kind) && canTick(line, kind) && isTicked(line)).length;
  const progress = (kind: BatchMode) => {
    const [scope, done, waiting, noun] = kind === "charge" ? [orderScope, ordersDone, toOrder, "Supplier orders"] as const : [creditScope, creditsDone, toCredit, "Supplier credits"] as const;
    if (!waiting) return { done: scope.length > 0, text: `${noun} recorded · ${done} of ${scope.length}` };
    const count = tickedFor(kind);
    return { done: count === waiting, text: `${noun} · ${count} of ${waiting} ticked to record${done ? ` · ${done} recorded` : ""}` };
  };
  const waiting = lines.filter((line) => nextBatchStep(line, "charge"));
  const charged = lines.reduce((sum, line) => sum + line.capturedCents - line.refundedCents, 0);
  const onHold = lines.reduce((sum, line) => sum + line.heldCents, 0);
  const released = lines.reduce((sum, line) => sum + line.releasedCents, 0);
  const refundDue = lines.reduce((sum, line) => sum + toRefund(line), 0);
  const whole = Math.max(1, charged + onHold + released + refundDue);
  const late = waiting.filter((line) => overdue.has(lineKey(line)));
  const client = order.clientName.split(" ")[0];
  const seg = (cents: number, color: string, striped?: boolean) => <i className="block h-full transition-[width] duration-500" style={{ width: `${(cents / whole) * 100}%`, background: striped ? `repeating-linear-gradient(135deg, ${color} 0 4px, #fff 4px 7px)` : color }} />;

  const card = <section className={CARD} aria-label="Orders and payments">
      <div className={`flex flex-wrap items-center gap-2.5 px-4 ${open ? "pb-0.5 pt-3.5" : "py-[11px]"}`}>
        <ModuleTitle open={open} onToggle={() => setOpen((value) => !value)}>Orders and payments</ModuleTitle>
        {!open && <span className="text-[12px] text-[var(--muted)]">{toOrder} to order · {toCredit} credits due</span>}
      </div>
      {open && <>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-[var(--line)] px-3 py-[9px]">
          <span role="tablist" aria-label="Orders and payments" className="inline-flex gap-0.5 rounded-[10px] border border-[var(--line)] bg-[var(--canvas)] p-[3px]">
            {([["charge", `To order · ${toOrder}`], ["refund", `Credits · ${toCredit}`], ["all", `All items · ${lines.length}`]] as const).map(([id, label]) =>
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`whitespace-nowrap rounded-[7px] px-[11px] py-1 text-[12px] ${tab === id ? "bg-white font-semibold text-[var(--ink)] shadow-[0_1px_2px_rgba(30,32,28,.12)]" : "font-medium text-[var(--muted)]"}`}>{label}</button>)}
          </span>
          <span className="flex-1" />
          {tab === "charge" && <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted)]">View by<select aria-label="View by" value={view} onChange={(event) => setView(event.target.value as "supplier" | "status")} className={SELECT}><option value="supplier">Supplier</option><option value="status">Status</option></select></label>}
          <a href={`/receipts/${order.projectKey}/${order.version}`} className={GHOST}><Eye className="h-[15px] w-[15px]" />Signed V{workspace.version}</a>
        </div>
        {table()}
        {tab === "charge" && demo && list.length > 0 && <p className="border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--muted)]">Demo: there is no real supplier, so each order number is filled in and each confirmation matches what {client} signed. Change a quantity or price to see a confirmation that differs.</p>}
        {startError && <p role="alert" className="border-t border-[var(--line)] px-4 py-2 text-[12px] text-red-700">{startError}</p>}
      </>}
    </section>;

  const side = <SumRow>
      <section className={`${CARD} grid content-start gap-[9px] px-5 pb-5 pt-[18px]`} aria-label={`${client}'s money on V${workspace.version}`}>
        <h3 className="mb-1 text-[15px] font-bold">{client}&apos;s money on V{workspace.version}</h3>
        <div className="grid grid-cols-2 gap-2">
          <Tile swatch="#30362d" label="Charged" cents={charged} note="Captured by PayPal" />
          <Tile swatch="#d7262e" label="On hold" cents={onHold} note="Waiting for a supplier order" />
          <Tile swatch="#b7d7c4" label="Released" cents={released} note={`Back on ${client}'s card`} striped />
          <Tile swatch="#ffcc70" label="To refund" cents={refundDue} note="After each supplier credit" />
        </div>
        <div role="img" aria-label={`${usd(charged)} charged, ${usd(onHold)} on hold, ${usd(released)} released, ${usd(refundDue)} to refund`} className="flex h-2.5 overflow-hidden rounded-full bg-[#ebe9e2]">{seg(charged, "#30362d")}{seg(onHold, "#d7262e")}{seg(released, "#b7d7c4", true)}{seg(refundDue, "#ffcc70")}</div>
        <p className="text-[11.5px] text-[var(--muted)]">A hold is not a charge, and a release is not a refund. Each line is its own PayPal step.</p>
      </section>
      <section className={`${CARD} grid content-start gap-[9px] px-5 pb-5 pt-[18px]`} aria-label="Setti's daily check">
        <div className="mb-1 flex items-center justify-between gap-2"><h3 className="text-[15px] font-bold">Setti&apos;s daily check</h3>
          <span className={`inline-flex items-center gap-[5px] rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold before:h-1.5 before:w-1.5 before:rounded-full before:bg-current before:opacity-60 ${!waiting.length ? "bg-emerald-50 text-emerald-700" : late.length ? "bg-[#fffbeb] text-[#92400e]" : "bg-[#efede6] text-[#4b5348]"}`}>{!waiting.length ? "All charged" : late.length ? `${late.length} overdue` : `${waiting.length} to order`}</span></div>
        {!waiting.length ? <p className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700"><Check className="h-3.5 w-3.5" strokeWidth={3} />Every hold is charged. Nothing is waiting for you.</p>
          : late.length ? <p className="flex items-start gap-2 rounded-lg border border-[#fde68a] bg-[#fffbeb] px-2.5 py-2 text-[12.5px] text-[#92400e]"><CircleAlert className="mt-0.5 h-[15px] w-[15px] shrink-0" /><span><b>{attention ? `Day ${attention.simulatedDays} · ${dayLabel(attention.checkedAt)}:` : "Overdue:"}</b> PayPal&apos;s 3-day honor period is over for {late.length} {late.length === 1 ? "hold" : "holds"} and no supplier order is recorded. A reminder for each is in your Inbox.</span></p>
            : <p className="text-[11.5px] text-[var(--muted)]">{attention?.watching.until ? `Record each supplier order by ${dayLabel(attention.watching.until)}, while PayPal's 3-day honor period for the holds lasts.` : "Record each supplier order within PayPal's 3-day honor period for the holds."} Setti checks every morning.</p>}
        {waiting.length > 0 && <ul className="grid">{waiting.map((line) => <li key={lineKey(line)} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2.5 border-b border-[var(--line)] py-[7px] text-[12.5px]"><span className="truncate">{line.label}</span><span className="text-[var(--muted)]">{supplierOf(line)}</span><b className="tabular-nums">{usd(line.heldCents)}</b></li>)}</ul>}
      </section>
    </SumRow>;

  const bar = <SendBar>
      <span className="flex flex-1 flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-[#4b5348]">
        {(["charge", "refund"] as const).map((kind) => { const item = progress(kind); return <Todo key={kind} done={item.done}>{item.text}</Todo>; })}
      </span>
      {workspace.reason && <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]"><LockKeyhole className="h-3.5 w-3.5" />{workspace.reason}</span>}
      <button type="button" disabled={disabled || (!orders.length && !credits.length) || running} onClick={runAll} className={SEND}>
        {(running || busy === "handover") && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
        {busy === "handover" ? `All recorded · switching to ${client}…` : runLabel}
      </button>
    </SendBar>;

  return <EditorLayout main={<>{head}{card}</>} side={side} bar={bar} />;
}
