"use client";

import { AllCommunityModule, type ColDef, type ICellRendererParams, type RowClassParams, type RowHeightParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ChevronDown, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import type { PricingChangeInput, PricingIssue } from "@/pricing/types";
import { requiresOldItemHandling } from "@/pricing/calculation";
import type { ApprovedQuoteLine } from "@/quotes/types";
import { calculateLineTotals } from "@/quotes/totals";
import { BrandMark } from "../BrandMark";
import { centsText, pricingTheme, shortMoney } from "./common";

/** The fields a cell in the grid edits; the rest open in the item's details. */
export type EditableGridField = "name" | "vendor" | "sku" | "quantity" | "unitLabel" | "unitPriceCents" | "taxCents" | "freightCents";
/** What the designer typed, by change and field, while it is not yet a valid number. */
export type RawFields = Record<string, string>;
export function fieldKey(key: string, field: string): string { return `${key}:${field}`; }

export type ItemsView = "section" | "supplier" | "change";
export interface ItemsColumns { type: boolean; supplier: boolean; sku: boolean; source: boolean }
export const INTERNAL_COLUMNS: { key: keyof ItemsColumns; label: string }[] = [
  { key: "type", label: "Type" }, { key: "supplier", label: "Supplier" }, { key: "sku", label: "SKU" }, { key: "source", label: "Source" },
];

type Status = "same" | "new" | "changed" | "replaced" | "removed";
interface Tone { bg: string; bar: string }
const TONES: Tone[] = [
  { bg: "#fbf1dc", bar: "#c98a1b" }, { bg: "#e8f0e4", bar: "#5f8a55" }, { bg: "#e6edf6", bar: "#4f74a8" },
  { bg: "#eeeaf5", bar: "#7a64a8" }, { bg: "#e2f0ef", bar: "#3f8a85" }, { bg: "#f6e7e1", bar: "#b0654a" },
];
/** The Change view keeps fixed colors, so New, Changed and Removed always look the same. */
const STATUS_TONES: Record<string, Tone> = {
  new: { bg: "#e6edf6", bar: "#4f74a8" }, changed: { bg: "#fbf1dc", bar: "#c98a1b" }, removed: { bg: "#f6e7e1", bar: "#b0654a" }, same: { bg: "#efede6", bar: "#a9a597" },
};

interface LineRow {
  kind: "line"; id: string; tone: Tone; status: Status; changeKey: string | null; drafted: boolean;
  name: string; detail: string; replaces: string | null; type: string; supplier: string; sku: string; source: string; unit: string;
  quantity: number | null; oldQuantity: number | null; unitPrice: number | null; oldUnitPrice: number | null;
  total: number | null; oldTotal: number | null; difference: number | null; editable: boolean;
  checked: boolean | null; questions: PricingIssue[];
}
interface FeeRow { kind: "fee"; id: string; tone: Tone; changeKey: string; label: string; amount: number | null }
interface GroupRow { kind: "group"; id: string; tone: Tone; name: string; count: number; subtotal: number | null; difference: number | null; checkKeys: string[]; checked: number }
interface QuestionRow { kind: "question"; id: string; tone: Tone; issue: PricingIssue; changeKey: string | null; about: string | null }
type GridRow = LineRow | FeeRow | GroupRow | QuestionRow;

const total = (line: { quantity: number; unitPriceCents: number | null; taxCents: number | null; freightCents: number | null } | null | undefined): number | null => {
  if (!line || line.unitPriceCents === null) return null;
  try { return calculateLineTotals({ quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents ?? 0, freightCents: line.freightCents ?? 0 }).totalCents; }
  catch { return null; }
};
const sum = (values: (number | null)[]): number | null => values.some((value) => value === null) ? null : values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/gu) ?? []);

/**
 * Which line a question is about: the one whose name shares the most words with
 * it, when exactly one does and by at least two words. Otherwise it stands on its own.
 */
export function questionLines(issues: readonly PricingIssue[], names: { key: string; name: string }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const issue of issues) {
    const asked = words(issue.label);
    const scores = names.map(({ name }) => [...words(name)].filter((word) => asked.has(word)).length);
    const best = Math.max(0, ...scores);
    out.set(issue.id, best >= 2 && scores.filter((score) => score === best).length === 1 ? names[scores.indexOf(best)].key : null);
  }
  return out;
}

function statusOf(change: PricingChangeInput | undefined, before: ApprovedQuoteLine | undefined): Status {
  if (!change) return "same";
  if (change.action === "add") return "new";
  if (change.action === "remove") return "removed";
  if (change.action === "replace") return "replaced";
  return before && change.after && (before.quantity !== change.after.quantity || before.unitPriceCents !== change.after.unitPriceCents) ? "changed" : "changed";
}

export function QuoteItemsGrid({ changes, baselineLines, issues, raw, disabled, drafted, view, columns, selectedKey, onSelect, onEdit, onCheck, onResolve }: {
  changes: PricingChangeInput[];
  baselineLines: readonly ApprovedQuoteLine[];
  issues: PricingIssue[];
  raw: RawFields;
  disabled: boolean;
  /** The changes came from Setti's draft, so each needs the designer's check. */
  drafted: boolean;
  view: ItemsView;
  columns: ItemsColumns;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onEdit: (key: string, field: EditableGridField, value: string) => void;
  onCheck: (keys: string[], confirmed: boolean) => void;
  onResolve: (issueId: string, resolved: boolean) => void;
}) {
  const [openQuestions, setOpenQuestions] = useState<Record<string, boolean>>(() => {
    const first = issues.find((issue) => !issue.resolved);
    return first ? { [first.id]: true } : {};
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const rows = useMemo<GridRow[]>(() => {
    const byItem = new Map(changes.filter((change) => change.itemId).map((change) => [change.itemId!, change]));
    // Every line of the quote, the changed ones with their change, then the new ones.
    const entries: { change?: PricingChangeInput; before?: ApprovedQuoteLine }[] = [
      ...baselineLines.map((before) => ({ before, change: byItem.get(before.itemId) })),
      ...changes.filter((change) => change.action === "add").map((change) => ({ change })),
    ];
    const names = entries.filter((entry) => entry.change).map(({ change, before }) => ({ key: change!.key, name: change!.after?.name ?? before?.name ?? "" }));
    const about = questionLines(issues, names);
    const rooms = new Set(entries.map(({ change, before }) => change?.after?.room ?? before?.room ?? ""));
    const groupOf = ({ change, before }: { change?: PricingChangeInput; before?: ApprovedQuoteLine }): string => {
      if (view === "supplier") return (change?.after?.vendor ?? before?.vendor ?? "").replace(/\s*\(demo\)$/, "") || "No supplier";
      if (view === "change") { const status = statusOf(change, before); return status === "replaced" ? "changed" : status; }
      // One room for the whole quote: its services and its products.
      if (rooms.size < 2) return (change?.after?.category ?? before?.category) === "service" ? "Services" : "Products";
      return change?.after?.room ?? before?.room ?? "Other";
    };
    const changeNames: Record<string, string> = { new: "New in this version", changed: "Changed", removed: "Removed", same: "Unchanged from the last version" };
    const order = view === "change" ? ["new", "changed", "removed", "same"] : [...new Set(entries.map(groupOf))];
    const out: GridRow[] = [];
    const orphanQuestions = issues.filter((issue) => about.get(issue.id) === null);
    if (orphanQuestions.length) {
      const tone = TONES[5];
      out.push({ kind: "group", id: "group:questions", tone, name: "Setti's questions", count: orphanQuestions.length, subtotal: null, difference: null, checkKeys: [], checked: 0 });
      orphanQuestions.forEach((issue) => out.push({ kind: "question", id: `question:${issue.id}`, tone, issue, changeKey: null, about: null }));
    }
    order.forEach((group, index) => {
      const members = entries.filter((entry) => groupOf(entry) === group);
      if (!members.length) return;
      const tone = view === "change" ? STATUS_TONES[group] : TONES[index % TONES.length];
      const lines: GridRow[] = [];
      const totals: (number | null)[] = [], diffs: (number | null)[] = [];
      const checkKeys: string[] = [];
      let checked = 0;
      for (const { change, before } of members) {
        const after = change?.after ?? null;
        const status = statusOf(change, before);
        const shown = after ?? before!;
        const lineTotal = status === "removed" ? 0 : change ? total(after) : total(before);
        const oldTotal = before ? total(before) : null;
        const fees = change && requiresOldItemHandling(change, before) ? change.oldItemFees : [];
        const feeTotal = change && requiresOldItemHandling(change, before) ? change.oldItemCostCents : 0;
        const difference = change ? (lineTotal === null || (before && oldTotal === null) ? null : lineTotal - (oldTotal ?? 0)) : 0;
        if (change && drafted) { checkKeys.push(change.key); if (change.confirmed) checked++; }
        const questions = change ? issues.filter((issue) => about.get(issue.id) === change.key) : [];
        lines.push({
          kind: "line", id: change ? `change:${change.key}` : `line:${before!.itemId}`, tone, status, changeKey: change?.key ?? null, drafted: !!change && drafted,
          name: shown.name, detail: shown.specification, replaces: status === "replaced" && before ? before.name : null,
          type: shown.category === "service" ? "Service" : "Product", supplier: (shown.vendor ?? "").replace(/\s*\(demo\)$/, ""), sku: shown.sku ?? "",
          source: before?.source && "reference" in before.source ? String((before.source as { reference?: string }).reference ?? "") : after?.sourceUrl ?? "",
          unit: shown.unitLabel ?? "each",
          quantity: status === "removed" ? before!.quantity : shown.quantity,
          oldQuantity: change && before && after && before.quantity !== after.quantity ? before.quantity : null,
          unitPrice: status === "removed" ? before!.unitPriceCents : after ? after.unitPriceCents : before!.unitPriceCents,
          oldUnitPrice: change && before && after && before.unitPriceCents !== after.unitPriceCents ? before.unitPriceCents : null,
          total: lineTotal, oldTotal: change ? oldTotal : null, difference,
          editable: !disabled && !!after, checked: change && drafted ? change.confirmed : null, questions,
        });
        totals.push(lineTotal, feeTotal); diffs.push(difference, feeTotal);
        fees.forEach((fee) => lines.push({ kind: "fee", id: `fee:${change!.key}:${fee.kind}`, tone, changeKey: change!.key, label: feeLabel(fee.kind), amount: fee.amountCents }));
        if (!fees.length && change && requiresOldItemHandling(change, before) && change.oldItemCostCents === null) lines.push({ kind: "fee", id: `fee:${change.key}:unknown`, tone, changeKey: change.key, label: "Cost the supplier keeps", amount: null });
        for (const issue of questions) if (openQuestions[issue.id]) lines.push({ kind: "question", id: `question:${issue.id}`, tone, issue, changeKey: change!.key, about: shown.name });
      }
      const id = `group:${group}`;
      out.push({ kind: "group", id, tone, name: view === "change" ? changeNames[group] : group, count: members.length, subtotal: sum(totals), difference: sum(diffs), checkKeys, checked });
      if (!collapsed[id]) out.push(...lines);
    });
    return out;
  }, [changes, baselineLines, issues, view, collapsed, openQuestions, drafted, disabled]);

  const anyCheck = drafted && changes.length > 0;
  const columnDefs = useMemo<ColDef<GridRow>[]>(() => {
    const stripe = ({ data }: { data?: GridRow }) => data ? { display: "flex", alignItems: "center", boxShadow: `inset 3px 0 0 ${data.tone.bar}` } : undefined;
    // Column types replace a default cell class, so the vertical centring is a style on each column.
    const right = { display: "flex", alignItems: "center", justifyContent: "flex-end" };
    const internal = (label: string) => `${label}`;
    return [
      { colId: "by", headerName: "", width: 40, pinned: "left", cellStyle: stripe, cellRenderer: ByCell, suppressHeaderMenuButton: true },
      { colId: "item", headerName: "Item", minWidth: 290, flex: 3, pinned: "left", cellRenderer: ItemCell, autoHeight: false },
      { colId: "type", headerName: internal("Type"), headerComponentParams: { internal: true }, headerComponent: Header, width: 96, hide: !columns.type, valueGetter: ({ data }) => data?.kind === "line" ? data.type : "" },
      { colId: "supplier", headerName: "Supplier", headerComponentParams: { internal: true }, headerComponent: Header, minWidth: 150, flex: 1, hide: !columns.supplier, valueGetter: ({ data }) => data?.kind === "line" ? data.supplier : "" },
      { colId: "sku", headerName: "SKU", headerComponentParams: { internal: true }, headerComponent: Header, width: 170, hide: !columns.sku, cellClass: "font-mono text-[11px]", valueGetter: ({ data }) => data?.kind === "line" ? data.sku : "" },
      { colId: "unit", headerName: "Unit", width: 92, valueGetter: ({ data }) => data?.kind === "line" ? data.unit : "" },
      {
        colId: "quantity", headerName: "Qty", width: 96, type: "rightAligned", cellStyle: right, cellRenderer: NumberCell, cellRendererParams: { field: "quantity" },
        editable: ({ data }) => data?.kind === "line" && data.editable,
        valueGetter: ({ data }) => data?.kind === "line" && data.changeKey ? raw[fieldKey(data.changeKey, "quantity")] ?? (data.quantity === null ? "" : String(data.quantity)) : data?.kind === "line" ? String(data.quantity ?? "") : "",
      },
      {
        colId: "unitPriceCents", headerName: "Unit price", width: 120, type: "rightAligned", cellStyle: right, cellRenderer: NumberCell, cellRendererParams: { field: "unitPriceCents" },
        editable: ({ data }) => data?.kind === "line" && data.editable,
        valueGetter: ({ data }) => data?.kind === "line" && data.changeKey ? raw[fieldKey(data.changeKey, "unitPriceCents")] ?? centsText(data.unitPrice) : data?.kind === "line" ? centsText(data.unitPrice) : "",
      },
      { colId: "source", headerName: "Source", headerComponentParams: { internal: true }, headerComponent: Header, minWidth: 170, hide: !columns.source, cellClass: "font-mono text-[11px]", valueGetter: ({ data }) => data?.kind === "line" ? data.source : "" },
      { colId: "total", headerName: "Total", width: 116, pinned: "right", type: "rightAligned", cellStyle: right, cellRenderer: TotalCell },
      { colId: "difference", headerName: "Change", width: 104, pinned: "right", type: "rightAligned", cellStyle: right, cellRenderer: DifferenceCell },
      ...(anyCheck ? [{ colId: "check", headerName: "Check", headerComponentParams: { internal: true }, headerComponent: Header, width: 78, pinned: "right" as const, cellRenderer: CheckCell }] : []),
    ];
  }, [columns, raw, anyCheck]);

  const context = useMemo(() => ({
    disabled, selectedKey, onSelect, onCheck, onResolve,
    toggleQuestion: (id: string) => setOpenQuestions((open) => ({ ...open, [id]: !open[id] })),
    openQuestions,
    toggleGroup: (id: string) => setCollapsed((shut) => ({ ...shut, [id]: !shut[id] })),
    collapsed,
  }), [disabled, selectedKey, onSelect, onCheck, onResolve, openQuestions, collapsed]);

  const heights = (row: GridRow) => row.kind === "group" ? 40 : row.kind === "question" ? 46 : row.kind === "fee" ? 34 : row.detail || row.replaces || row.questions.length ? 58 : 44;
  const fullHeight = rows.reduce((acc, row) => acc + heights(row), 0) + 42;
  return <div className="overflow-hidden rounded-xl border border-[var(--line)]">
    <div style={{ height: Math.min(fullHeight + 16, 660) }} className="w-full">
      <AgGridReact<GridRow> modules={[AllCommunityModule]} theme={pricingTheme} rowData={rows} columnDefs={columnDefs} context={context}
        getRowId={({ data }) => data.id} headerHeight={40}
        getRowHeight={({ data }: RowHeightParams<GridRow>) => data ? heights(data) : 44}
        isFullWidthRow={({ rowNode }) => rowNode.data?.kind === "group" || rowNode.data?.kind === "question"}
        fullWidthCellRenderer={FullWidthRow}
        getRowStyle={({ data }: RowClassParams<GridRow>) => data?.kind === "line" && data.changeKey && data.changeKey === selectedKey ? { backgroundColor: "#fffaf0" } : data?.kind === "fee" ? { backgroundColor: "#fdfcf9" } : undefined}
        defaultColDef={{ resizable: true, sortable: false, suppressMovable: true, cellDataType: false, cellStyle: { display: "flex", alignItems: "center" } }}
        readOnlyEdit singleClickEdit stopEditingWhenCellsLoseFocus enableCellTextSelection suppressCellFocus={false}
        onCellEditRequest={({ data, colDef, newValue }) => { if (data?.kind === "line" && data.changeKey && data.editable) onEdit(data.changeKey, colDef.colId as EditableGridField, String(newValue ?? "")); }}
        onCellClicked={({ data, colDef }) => { if (data?.kind === "line" && data.changeKey && (colDef.colId === "item" || colDef.colId === "by")) onSelect(data.changeKey); if (data?.kind === "fee" && colDef.colId !== "check") onSelect(data.changeKey); }} />
    </div>
    <p className="border-t border-[var(--line)] bg-[var(--canvas)] px-3 py-2 text-[10.5px] text-[var(--muted)]">Yellow cells differ from the last signed version; the old value is struck through above. Editing a value clears that line&apos;s check. Open an item to see all its details.</p>
  </div>;
}

function feeLabel(kind: string): string {
  return ({ restocking_fee: "Restocking fee", fabrication_fee: "Fabrication fee", shipping: "Return shipping", material_cost: "Material cost", cancellation_fee: "Cancellation fee", other: "Other cost" } as Record<string, string>)[kind] ?? "Cost the supplier keeps";
}

type Ctx = {
  disabled: boolean; selectedKey: string | null; onSelect: (key: string) => void; onCheck: (keys: string[], confirmed: boolean) => void; onResolve: (id: string, resolved: boolean) => void;
  toggleQuestion: (id: string) => void; openQuestions: Record<string, boolean>; toggleGroup: (id: string) => void; collapsed: Record<string, boolean>;
};
type Cell = ICellRendererParams<GridRow, unknown, Ctx>;

function Header({ displayName, internal }: { displayName: string; internal?: boolean }) {
  return <span className="inline-flex items-center gap-1" title={internal ? "Only you see this column. It never appears on the client's quote." : undefined}>{internal && <EyeOff className="h-3 w-3" aria-hidden />}{displayName}{internal && <span className="sr-only"> (not shown to the client)</span>}</span>;
}

function ByCell({ data }: Cell) {
  if (data?.kind !== "line" || !data.drafted) return null;
  return <span title="Drafted by Setti" className="inline-flex h-full items-center"><BrandMark className="h-4 w-4" /></span>;
}

const CHIP: Record<Status, string | null> = { same: null, new: "New", changed: "Changed", replaced: "Replaces", removed: "Removed" };
const CHIP_STYLE: Record<Status, string> = {
  same: "", new: "bg-[#eef6ff] text-[#1d4f91]", changed: "bg-[#fff3c4] text-[var(--primary)]", replaced: "bg-[#eef6ff] text-[#1d4f91]", removed: "bg-[#fdf1f0] text-[#9c3d34]",
};

function ItemCell({ data, context }: Cell) {
  if (!data) return null;
  if (data.kind === "fee") return <span className="flex h-full items-center gap-2 pl-3 text-[12px] text-slate-600">↳ {data.label}<span className="rounded-full bg-[#fdeceb] px-1.5 text-[10px] font-semibold text-[#9c3d34]">Not refundable</span></span>;
  if (data.kind !== "line") return null;
  const chip = CHIP[data.status];
  const open = data.questions.some((issue) => context.openQuestions[issue.id]);
  const answered = data.questions.every((issue) => issue.resolved);
  return <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <button type="button" disabled={!data.changeKey} onClick={() => data.changeKey && context.onSelect(data.changeKey)} className={`truncate text-left text-[12.5px] font-semibold ${data.changeKey ? "hover:underline" : "cursor-default"} ${data.status === "removed" ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>{data.name}</button>
      {chip && <span className={`rounded px-1.5 text-[10px] font-bold ${CHIP_STYLE[data.status]}`}>{data.status === "replaced" && data.replaces ? `Replaces ${data.replaces}` : chip}</span>}
      {data.questions.length > 0 && <button type="button" onClick={() => data.questions.forEach((issue) => context.toggleQuestion(issue.id))} aria-expanded={open}
        className={`inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-semibold ${answered ? "text-emerald-700" : "text-amber-800"} hover:bg-[var(--canvas)]`}>
        {answered ? "Confirmed" : `${data.questions.length} ${data.questions.length === 1 ? "question" : "questions"}`}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>}
    </div>
    {data.detail && <span className="mt-0.5 truncate text-[11px] text-[var(--muted)]">{data.detail}</span>}
  </div>;
}

function NumberCell({ data, value, colDef }: Cell & { value?: string }) {
  if (data?.kind !== "line") return null;
  const isPrice = colDef?.colId === "unitPriceCents";
  const old = isPrice ? data.oldUnitPrice : data.oldQuantity;
  const shown = isPrice ? (value ? shortMoney(Math.round(Number(value) * 100)) : "Unknown") : value;
  const changed = data.status !== "same" && data.status !== "removed" && (old !== null || data.status === "new");
  return <div className="flex h-full flex-col items-end justify-center leading-tight">
    {old !== null && <span className="text-[10.5px] text-[var(--muted)] line-through">{isPrice ? shortMoney(old) : old}</span>}
    <span className={`rounded px-1 ${changed && old !== null ? "bg-[#fff3c4]" : ""} ${data.status === "removed" ? "text-[var(--muted)] line-through" : ""} ${data.editable ? "border-b border-dashed border-[#cfcab9]" : ""}`}>{shown}</span>
  </div>;
}

function TotalCell({ data }: Cell) {
  if (data?.kind === "fee") return <span className="flex h-full items-center justify-end">{data.amount === null ? <span className="text-amber-800">Enter it</span> : shortMoney(data.amount)}</span>;
  if (data?.kind !== "line") return null;
  return <div className="flex h-full flex-col items-end justify-center leading-tight">
    {data.status === "removed" && data.oldTotal !== null && <span className="text-[10.5px] text-[var(--muted)] line-through">{shortMoney(data.oldTotal)}</span>}
    <b className="font-semibold">{data.total === null ? "—" : shortMoney(data.total)}</b>
  </div>;
}

function DifferenceCell({ data }: Cell) {
  const value = data?.kind === "line" ? data.difference : data?.kind === "fee" ? data.amount : null;
  if (!data || (data.kind !== "line" && data.kind !== "fee")) return null;
  if (data.kind === "line" && !data.changeKey) return <span className="flex h-full items-center justify-end text-[var(--muted)]">—</span>;
  return <span className={`flex h-full items-center justify-end font-medium ${value === null ? "text-[var(--muted)]" : value > 0 ? "text-[#9c3d34]" : value < 0 ? "text-emerald-700" : "text-[var(--muted)]"}`}>{value === null ? "—" : value === 0 ? "$0" : `${value > 0 ? "+" : "−"}${shortMoney(Math.abs(value))}`}</span>;
}

function CheckCell({ data, context }: Cell) {
  if (data?.kind !== "line" || data.checked === null || !data.changeKey) return null;
  const key = data.changeKey;
  return <span className="flex h-full items-center justify-end"><input type="checkbox" aria-label={`Checked ${data.name}`} checked={data.checked} disabled={context.disabled}
    onChange={(event) => context.onCheck([key], event.target.checked)} className="h-4 w-4 accent-emerald-700" /></span>;
}

/** A group's heading or a question under its line, across the whole width. */
function FullWidthRow({ data, context }: Cell) {
  if (!data) return null;
  if (data.kind === "group") {
    const open = !context.collapsed[data.id];
    const all = data.checkKeys.length > 0 && data.checked === data.checkKeys.length;
    const some = data.checked > 0 && !all;
    return <div className="flex h-full items-center gap-3 px-3 text-[12.5px]" style={{ background: data.tone.bg, boxShadow: `inset 3px 0 0 ${data.tone.bar}` }}>
      <button type="button" onClick={() => context.toggleGroup(data.id)} aria-expanded={open} className="inline-flex items-center gap-1.5 font-bold">
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />{data.name}
      </button>
      <span className="text-[var(--muted)]">{data.count} {data.count === 1 ? "item" : "items"}</span>
      <span className="ml-auto font-semibold tabular-nums">{data.subtotal === null ? "" : shortMoney(data.subtotal)}</span>
      <span className={`w-[92px] text-right font-semibold tabular-nums ${data.difference === null || data.difference === 0 ? "text-[var(--muted)]" : data.difference > 0 ? "text-[#9c3d34]" : "text-emerald-700"}`}>{data.difference === null || data.difference === 0 ? "—" : `${data.difference > 0 ? "+" : "−"}${shortMoney(Math.abs(data.difference))}`}</span>
      <span className="flex w-[64px] items-center justify-end">{data.checkKeys.length > 0 && <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]" title={`Check every line Setti drafted in ${data.name}`}>
        All<input type="checkbox" checked={all} ref={(input) => { if (input) input.indeterminate = some; }} disabled={context.disabled}
          onChange={(event) => context.onCheck(data.checkKeys, event.target.checked)} aria-label={`Check all lines Setti drafted in ${data.name}`} className="h-4 w-4 accent-emerald-700" /></label>}</span>
    </div>;
  }
  if (data.kind === "question") {
    const done = data.issue.resolved;
    return <div className={`flex h-full items-center gap-2.5 border-b border-dashed border-[var(--line)] pl-[52px] pr-3 text-[12px] ${done ? "bg-emerald-50/60 text-emerald-800" : "bg-[#fbfaf7] text-slate-700"}`} style={{ boxShadow: `inset 3px 0 0 ${data.tone.bar}` }}>
      <BrandMark className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={data.issue.label}><b>{done ? "Confirmed" : "Setti asks"}:</b> {data.issue.label}</span>
      {done
        ? <button type="button" disabled={context.disabled} onClick={() => context.onResolve(data.issue.id, false)} className="text-[11.5px] font-semibold text-[var(--primary)] underline">Undo</button>
        : <button type="button" disabled={context.disabled} onClick={() => context.onResolve(data.issue.id, true)} className="rounded-md bg-[var(--ink)] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-[#1f241d] disabled:opacity-50">Yes, confirmed</button>}
    </div>;
  }
  return null;
}
