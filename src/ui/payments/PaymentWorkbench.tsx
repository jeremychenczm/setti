"use client";

import { AllCommunityModule, themeQuartz, type ColDef, type ICellRendererParams, type RowSelectionOptions } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { FrozenChangeOrder } from "@/pricing/types";
import type { OperationView, PaymentLineView, PaymentStep, PaymentsWorkspace } from "@/payments/types";
import { money } from "../pricing/common";
import { useDemoMode } from "../demo-mode";
import { demoSupplierNumber } from "./demo-supplier";
import { lineProgress } from "./progress";

const modules = [AllCommunityModule];
const theme = themeQuartz.withParams({
  accentColor: "#b27a26", backgroundColor: "#ffffff", foregroundColor: "#30362d", borderColor: "#e7e5db",
  headerBackgroundColor: "#f7f6f2", headerTextColor: "#7b7f73", fontFamily: "inherit", fontSize: 12, headerFontSize: 11,
  rowHoverColor: "#fafaf8", selectedRowBackgroundColor: "#fffaf0", wrapperBorder: false,
});

/** Which run a line belongs to: its supplier confirms and it is charged, or the supplier credits it and it is refunded. */
export type BatchMode = "charge" | "refund";
export type BatchResult = { mode: BatchMode } & ({ state: "running" } | { state: "done"; text: string } | { state: "refused"; text: string });
export const lineKey = (line: Pick<PaymentLineView, "side" | "itemId">) => `${line.side}:${line.itemId}`;

const STEPS: Record<BatchMode, PaymentStep["kind"][]> = { charge: ["supplier_confirmation", "capture", "void"], refund: ["supplier_credit", "refund"] };
/** The designer's next step on a line within a run, if it has one now. */
export function nextBatchStep(line: PaymentLineView, mode: BatchMode): PaymentStep | null {
  return line.cancellation ? null : line.steps.find((step) => step.available && step.actor === "designer" && STEPS[mode].includes(step.kind)) ?? null;
}
const clientOwes = (line: PaymentLineView) => line.cancellation ? 0 : Math.max(0, line.targetCents - (line.capturedCents - line.refundedCents) - line.heldCents);
const toRefund = (line: PaymentLineView) => line.cancellation ? 0 : Math.max(0, line.capturedCents - line.refundedCents - line.targetCents);

interface Row { key: string; label: string; supplier: string; terms: string; amountCents: number; releaseCents: number; reference: string; status: string; result: BatchResult | null }

function Tile({ swatch, label, count, amount, note }: { swatch: string; label: string; count: string; amount: number; note: string }) {
  return <div className="min-w-0 rounded-xl border border-[var(--line)] bg-white p-3.5">
    <p className="flex items-center gap-2 text-[12px] font-semibold"><i aria-hidden className="h-2.5 w-2.5 shrink-0" style={{ background: swatch }} />{label}<span className="ml-auto text-[11px] font-normal text-[var(--muted)]">{count}</span></p>
    <p className="mt-1 text-[22px] font-bold tabular-nums tracking-tight">{money(amount)}</p>
    <p className="text-[11px] text-[var(--muted)]">{note}</p>
  </div>;
}

function StatusCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const result = data.result;
  if (result?.state === "running") return <span className="inline-flex items-center gap-1.5 text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Working…</span>;
  if (result?.state === "done") return <span className="inline-flex items-center gap-1 font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />{result.text}</span>;
  if (result?.state === "refused") return <span title={result.text} className="inline-flex items-center gap-1 font-medium text-red-700"><CircleAlert className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{result.text}</span></span>;
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">{data.status}</span>;
}

/**
 * The version's money, and the designer's supplier steps done together: tick the
 * lines whose supplier has confirmed (or credited), then one button records each
 * confirmation and runs its PayPal step, line by line. Each line is still checked
 * against the confirmed terms on its own; a line that differs is refused alone.
 */
export function PaymentWorkbench({ designer, workspace, order, operations, busy, disabled, results, onRun, onOpen, allItems }: {
  designer: boolean; workspace: PaymentsWorkspace; order: FrozenChangeOrder; operations: readonly OperationView[]; busy: string | null; disabled: boolean;
  results: Record<string, BatchResult>; onRun: (mode: BatchMode, items: { key: string; reference: string }[]) => void; onOpen: (key: string) => void; allItems: ReactNode;
}) {
  const demo = useDemoMode();
  const lines = workspace.lines;
  // A line stays in its list after a run, so its result shows where it was.
  const charge = lines.filter((line) => nextBatchStep(line, "charge") || results[lineKey(line)]?.mode === "charge");
  const refund = lines.filter((line) => nextBatchStep(line, "refund") || results[lineKey(line)]?.mode === "refund");
  const client = lines.filter((line) => clientOwes(line) > 0);
  const tabs = [
    { id: "charge", label: "Confirm & charge", lines: charge },
    { id: "refund", label: "Credit & refund", lines: refund },
    { id: "client", label: "Client pays", lines: client },
    { id: "all", label: "All items", lines },
  ] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>(() => charge.length ? "charge" : refund.length ? "refund" : "all");
  const [references, setReferences] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<string[] | null>(null);

  const supplierOf = (line: PaymentLineView) => (line.side === "baseline" ? order.changes.find((change) => change.itemId === line.itemId)?.before?.vendor : undefined)
    ?? order.lines.find((quoteLine) => quoteLine.itemId === line.itemId)?.vendor ?? "Supplier";
  const mode: BatchMode = tab === "refund" ? "refund" : "charge";
  const rows: Row[] = (tab === "refund" ? refund : charge).map((line) => {
    const key = lineKey(line);
    const step = (kind: PaymentStep["kind"]) => line.steps.find((item) => item.kind === kind);
    const terms = line.confirmedTerms;
    // A finished line shows what moved; a line that only has a hold left to release charges nothing.
    const finished = results[key]?.state === "done";
    const amount = finished ? mode === "refund" ? line.refundedCents : line.capturedCents - line.refundedCents
      : mode === "refund" ? step("refund")?.amountCents ?? step("supplier_credit")?.amountCents ?? toRefund(line)
        : step("capture")?.amountCents ?? (step("supplier_confirmation") && terms ? terms.quantity * terms.unitPriceCents + terms.taxCents + terms.freightCents : 0);
    return {
      key, label: line.label, supplier: supplierOf(line), amountCents: amount, releaseCents: mode === "charge" && !finished ? step("void")?.amountCents ?? Math.max(0, line.heldCents - amount) : 0,
      terms: mode === "refund" ? (line.nonRefundable?.oldItemCostCents ? `${money(line.capturedCents - line.refundedCents)} paid, ${money(line.nonRefundable.oldItemCostCents)} kept` : `${money(line.capturedCents - line.refundedCents)} paid`)
        : terms ? terms.purpose === "retained_cost" ? `Retained cost ${money(amount)}` : `${terms.quantity} × ${money(terms.unitPriceCents)}${terms.taxCents || terms.freightCents ? ` + ${money(terms.taxCents + terms.freightCents)}` : ""}` : "—",
      reference: references[key] ?? (demo ? demoSupplierNumber(mode === "refund" ? "credit" : "order", line.itemId) : ""),
      status: lineProgress(line, operations).label, result: results[key] ?? null,
    };
  });
  const runnable = rows.filter((row) => !row.result || row.result.state === "refused");
  const selected = (ticked ?? runnable.map((row) => row.key)).filter((key) => runnable.some((row) => row.key === key));
  const chosen = rows.filter((row) => selected.includes(row.key));
  const missing = chosen.filter((row) => !row.reference.trim());
  const total = chosen.reduce((sum, row) => sum + row.amountCents, 0);
  const released = chosen.reduce((sum, row) => sum + row.releaseCents, 0);
  const running = busy === `batch:${mode}`;

  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: "label", headerName: "Item", flex: 1.4, minWidth: 170, cellClass: "font-semibold" },
    { field: "supplier", headerName: "Supplier", flex: 1.1, minWidth: 140, cellClass: "text-slate-500" },
    { field: "terms", headerName: mode === "refund" ? "Paid so far" : `Confirmed in V${workspace.version}`, flex: 1, minWidth: 130 },
    { field: "reference", headerName: mode === "refund" ? "Credit note no. ✎" : "Supplier order no. ✎", flex: 1.1, minWidth: 150, editable: ({ data }) => !data?.result || data.result.state === "refused", cellClass: "font-mono text-[11px]" },
    { field: "amountCents", headerName: mode === "refund" ? "Refund" : "Charge", width: 175, type: "numericColumn", cellRenderer: ({ data }: ICellRendererParams<Row>) => data && <span className="tabular-nums">{money(data.amountCents)}{data.releaseCents > 0 && <span className="ml-1 text-[10px] text-[var(--muted)]">+{money(data.releaseCents)} released</span>}</span> },
    { colId: "status", headerName: "Status", flex: 1.2, minWidth: 170, cellRenderer: StatusCell, sortable: false },
    { colId: "edit", headerName: "", width: 70, sortable: false, cellRenderer: ({ data }: ICellRendererParams<Row>) => data && <button onClick={() => onOpen(data.key)} className="text-[12px] font-medium text-[var(--primary)] hover:underline">Edit</button> },
  ], [mode, workspace.version, onOpen]);
  const rowSelection = useMemo<RowSelectionOptions<Row>>(() => ({ mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false, hideDisabledCheckboxes: true, isRowSelectable: (node) => !!node.data && (!node.data.result || node.data.result.state === "refused") }), []);

  const held = lines.reduce((sum, line) => sum + line.heldCents, 0);
  const net = lines.reduce((sum, line) => sum + line.capturedCents - line.refundedCents, 0);
  const count = (list: readonly PaymentLineView[], test: (line: PaymentLineView) => boolean) => { const n = list.filter(test).length; return `${n} ${n === 1 ? "item" : "items"}`; };
  const active = tabs.find((item) => item.id === tab)!;

  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <Tile swatch="#d7262e" label="On hold" count={count(lines, (line) => line.heldCents > 0)} amount={held} note="Charged after each supplier confirms" />
      <Tile swatch="#ffcc70" label="Charged" count={count(lines, (line) => line.capturedCents > 0)} amount={net} note="Captured by PayPal, after refunds" />
      <Tile swatch="#f7a6a0" label="To refund" count={count(lines, (line) => toRefund(line) > 0)} amount={lines.reduce((sum, line) => sum + toRefund(line), 0)} note="After each supplier credit" />
      <Tile swatch="#ebe9e2" label="Client to pay" count={count(lines, (line) => clientOwes(line) > 0)} amount={lines.reduce((sum, line) => sum + clientOwes(line), 0)} note={`${order.clientName} pays from their own account`} />
    </div>

    {/* The client sees where each item stands; the supplier steps are the designer's. */}
    {!designer ? allItems : <div className="rounded-xl border border-[var(--line)] bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Next steps</h3>
        <div role="tablist" aria-label="Payment steps" className="flex flex-wrap gap-0.5 rounded-lg bg-[var(--canvas)] p-0.5">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id); setTicked(null); }}
          className={`rounded-md px-3 py-1.5 text-[12px] ${tab === item.id ? "bg-white font-semibold shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}>{item.label} <span className="tabular-nums">{item.lines.length}</span></button>)}</div>
      </div>

      {tab === "all" ? allItems : tab === "client" ? <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">{client.length ? client.map((line) => <li key={lineKey(line)} className="flex flex-wrap items-center gap-3 py-2.5 text-[12px]"><span className="min-w-40 flex-1 font-semibold">{line.label}</span><span className="tabular-nums">{money(clientOwes(line))}</span><span className="text-[var(--muted)]">{lineProgress(line, operations).next}</span></li>) : <li className="py-3 text-[12px] text-[var(--muted)]">{order.clientName} has nothing left to pay on this version.</li>}</ul>
        : active.lines.length === 0 ? <p className="rounded-lg bg-[var(--canvas)] px-3 py-3 text-[12px] text-[var(--muted)]">{tab === "charge" ? "No item is waiting for a supplier confirmation or a charge." : "No item is waiting for a supplier credit or a refund."}</p>
        : <>
          <div className="w-full" style={{ height: Math.min(420, 44 * Math.max(rows.length, 1) + 42) }}>
            <AgGridReact<Row> key={tab} modules={modules} theme={theme} rowData={rows} columnDefs={columns} defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
              rowSelection={rowSelection} selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, resizable: false, pinned: "left" }}
              getRowId={({ data }) => data.key} rowHeight={44} headerHeight={40} animateRows={false} readOnlyEdit singleClickEdit stopEditingWhenCellsLoseFocus
              onCellEditRequest={({ data, newValue }) => { if (data) setReferences((current) => ({ ...current, [data.key]: String(newValue ?? "") })); }}
              onFirstDataRendered={({ api }) => api.forEachNode((node) => { if (selected.includes(node.id ?? "")) node.setSelected(true); })}
              onSelectionChanged={({ api, source }) => { if (source !== "api") setTicked(api.getSelectedRows().map((row) => row.key)); }} />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{tab === "charge"
            ? `Ticking a line records that its supplier confirmed these terms${demo ? " (demo: there is no real supplier, so each line is filled in from what the client confirmed)" : ""}. Setti checks each line against V${workspace.version} on its own: a line that differs is refused and the others still go through. Each charge is its own PayPal capture.`
            : `Ticking a line records that its supplier issued this credit. Each refund is its own PayPal refund, from the item's completed capture.`} Select Edit to change a line&apos;s amounts.</p>
          {runnable.length === 0 ? <p role="status" className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-emerald-700"><Check className="h-3.5 w-3.5" />{tab === "charge" ? `All ${rows.length} recorded and charged.` : `All ${rows.length} credits recorded and refunded.`}</p> : <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" disabled={disabled || chosen.length === 0 || missing.length > 0} onClick={() => onRun(mode, chosen.map((row) => ({ key: row.key, reference: row.reference })))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2.5 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">
              {running && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              {tab === "charge" ? `Record ${chosen.length} ${chosen.length === 1 ? "confirmation" : "confirmations"} and charge ${money(total)}` : `Record ${chosen.length} ${chosen.length === 1 ? "credit" : "credits"} and refund ${money(total)}`}
            </button>
            {released > 0 && <span className="text-[12px] text-[var(--muted)]">The unused {money(released)} of the holds is released with them.</span>}
            {missing.length > 0 && <span className="text-[12px] text-amber-800">Enter the {tab === "charge" ? "supplier's order number" : "credit note number"} for {missing.map((row) => row.label).join(", ")}.</span>}
          </div>}
        </>}
    </div>}
  </div>;
}
