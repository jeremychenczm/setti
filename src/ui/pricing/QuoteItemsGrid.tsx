"use client";

import { Check, ChevronDown, EyeOff } from "lucide-react";
import { cloneElement, useMemo, useRef, useState, type ReactElement } from "react";
import type { PricingChangeInput, PricingIssue } from "@/pricing/types";
import { requiresOldItemHandling } from "@/pricing/calculation";
import type { ApprovedQuoteLine } from "@/quotes/types";
import { calculateLineTotals } from "@/quotes/totals";
import { BrandMark } from "../BrandMark";
import { matchQuestion } from "./question-match";
import { orderedUnits } from "@/pricing/calculation";
import { centsText, shortMoney } from "./common";

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
  kind: "line"; id: string; token: string; tone: Tone; status: Status; changeKey: string | null; drafted: boolean;
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
/** Which line each question is about, by its change key; null for a question that stands on its own. */
export function questionLines(issues: readonly PricingIssue[], names: { key: string; name: string }[]): Map<string, string | null> {
  return new Map(issues.map((issue) => { const at = matchQuestion(issue.label, names.map((entry) => entry.name)); return [issue.id, at === null ? null : names[at].key]; }));
}

function statusOf(change: PricingChangeInput | undefined, before: ApprovedQuoteLine | undefined): Status {
  if (!change) return "same";
  if (change.action === "add") return "new";
  if (change.action === "remove") return "removed";
  if (change.action === "replace") return "replaced";
  return before && change.after && (before.quantity !== change.after.quantity || before.unitPriceCents !== change.after.unitPriceCents) ? "changed" : "changed";
}

export function QuoteItemsGrid({ changes, baselineLines, issues, raw, disabled, drafted, view, columns, selectedKey, onSelect, onEdit, onCheck, onResolve, first = false, onRenameGroup, onAddItem, onMove, lineOrder }: {
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
  /** A first quote: every line is the designer's own, with nothing to compare or check. */
  first?: boolean;
  /** A first quote's sections are the designer's own: their headings can be renamed. */
  onRenameGroup?: (name: string) => void;
  /** Adds an item to one of a first quote's sections. */
  onAddItem?: (section: string) => void;
  /** Moves a line before or after another; only a first quote's lines can be reordered. */
  onMove?: (key: string, target: string, place: "before" | "after") => void;
  /** The designer's order of the lines, by signed item id or new line's change key. */
  lineOrder?: readonly string[];
}) {
  const [openQuestions, setOpenQuestions] = useState<Record<string, boolean>>(() => {
    const first = issues.find((issue) => !issue.resolved);
    return first ? { [first.id]: true } : {};
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const rows = useMemo<GridRow[]>(() => {
    const byItem = new Map(changes.filter((change) => change.itemId).map((change) => [change.itemId!, change]));
    // Every line of the quote, the changed ones with their change, then the new ones.
    const entries: { token: string; change?: PricingChangeInput; before?: ApprovedQuoteLine }[] = orderedUnits([
      ...baselineLines.map((before) => ({ token: before.itemId, before, change: byItem.get(before.itemId) })),
      ...changes.filter((change) => change.action === "add").map((change) => ({ token: change.key, change })),
    ], lineOrder);
    const names = entries.filter((entry) => entry.change).map(({ change, before }) => ({ key: change!.key, name: change!.after?.name ?? before?.name ?? "" }));
    const about = questionLines(issues, names);
    const rooms = new Set(entries.map(({ change, before }) => change?.after?.room ?? before?.room ?? ""));
    const groupOf = ({ change, before }: { change?: PricingChangeInput; before?: ApprovedQuoteLine }): string => {
      if (view === "supplier") return (change?.after?.vendor ?? before?.vendor ?? "").replace(/\s*\(demo\)$/, "") || "No supplier";
      if (view === "change") { const status = statusOf(change, before); return status === "replaced" ? "changed" : status; }
      // A first quote groups by the sections the designer named.
      if (first) return (change?.after?.room ?? "").trim() || "No section";
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
      for (const { token, change, before } of members) {
        const after = change?.after ?? null;
        const status = first ? "same" : statusOf(change, before);
        const shown = after ?? before!;
        const lineTotal = status === "removed" ? 0 : change ? total(after) : total(before);
        const oldTotal = before ? total(before) : null;
        const fees = change && requiresOldItemHandling(change, before) ? change.oldItemFees : [];
        const feeTotal = change && requiresOldItemHandling(change, before) ? change.oldItemCostCents : 0;
        const difference = change ? (lineTotal === null || (before && oldTotal === null) ? null : lineTotal - (oldTotal ?? 0)) : 0;
        if (change && drafted) { checkKeys.push(change.key); if (change.confirmed) checked++; }
        const questions = change ? issues.filter((issue) => about.get(issue.id) === change.key) : [];
        lines.push({
          kind: "line", id: change ? `change:${change.key}` : `line:${before!.itemId}`, token, tone, status, changeKey: change?.key ?? null, drafted: !!change && drafted,
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
  }, [changes, baselineLines, issues, view, collapsed, openQuestions, drafted, disabled, first, lineOrder]);

  const anyCheck = drafted && changes.length > 0;
  const renameGroup = view === "section" ? onRenameGroup : undefined;
  const addTo = view === "section" ? onAddItem : undefined;
  const toggleQuestion = (id: string) => setOpenQuestions((open) => ({ ...open, [id]: !open[id] }));
  const toggleGroup = (id: string) => setCollapsed((shut) => ({ ...shut, [id]: !shut[id] }));
  // Reordering: the line being dragged and where it would land.
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; place: "before" | "after" } | null>(null);
  const order = rows.flatMap((row) => row.kind === "line" ? [row.token] : []);
  const moveBy = (key: string, by: -1 | 1) => {
    const target = order[order.indexOf(key) + by];
    if (onMove && target) onMove(key, target, by < 0 ? "before" : "after");
  };

  // The plan's columns: who wrote it, the item, the internal columns that are switched on, then the numbers.
  const cols: Col[] = [
    { key: "grip", label: "" }, { key: "by", label: "" }, { key: "item", label: "Item" },
    ...INTERNAL_COLUMNS.filter((column) => columns[column.key]).map((column): Col => ({ key: column.key, label: column.label, internal: true })),
    { key: "unit", label: "Unit" }, { key: "quantity", label: "Qty", right: true }, { key: "unitPriceCents", label: "Unit price", right: true }, { key: "total", label: "Total", right: true },
    ...(first ? [] : [{ key: "difference", label: "Change", right: true } satisfies Col]),
    ...(anyCheck ? [{ key: "check", label: "Check", right: true, internal: true } satisfies Col] : []),
  ];
  const totalAt = cols.findIndex((col) => col.key === "total");
  const after = cols.length - totalAt - 1 - (first ? 0 : 1) - (anyCheck ? 1 : 0);

  // Rows come grouped: each group heading opens a tbody of its own, carrying the group's color.
  const groups: { head: GroupRow; rows: GridRow[] }[] = [];
  for (const row of rows) {
    if (row.kind === "group") groups.push({ head: row, rows: [] });
    else groups.at(-1)?.rows.push(row);
  }

  const td = "border-b border-[var(--line)] px-2 py-[7px] align-middle";
  // Every column but the item and its source stays on one line.
  const one = `${td} whitespace-nowrap`;
  const valueOf = (row: LineRow, field: "quantity" | "unitPriceCents") => {
    const typed = row.changeKey ? raw[fieldKey(row.changeKey, field)] : undefined;
    if (typed !== undefined) return typed;
    return field === "quantity" ? row.quantity === null ? "" : String(row.quantity) : centsText(row.unitPrice);
  };

  function line(row: LineRow) {
    const chip = CHIP[row.status];
    const open = row.questions.some((issue) => openQuestions[issue.id]);
    const answered = row.questions.every((issue) => issue.resolved);
    const removed = row.status === "removed";
    const cells: ReactElement<{ style?: { boxShadow?: string } }>[] = cols.map((col, index) => {
      const stripe = index === 0 ? { boxShadow: `inset 3px 0 0 ${row.tone.bar}` } : undefined;
      switch (col.key) {
        case "grip": return <td key={col.key} style={stripe} className={`${one} w-5 pl-2 pr-0`}>{onMove && !disabled
          ? <button type="button" draggable aria-label={`Move ${row.name}. Drag it, or use the up and down arrow keys`} title="Drag to move, or use the arrow keys"
              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.token); setDragging(row.token); }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveBy(row.token, event.key === "ArrowUp" ? -1 : 1); } }}
              className="cursor-grab rounded px-0.5 text-[11px] tracking-[-2px] text-[#c4bfae] hover:bg-[var(--canvas)] hover:text-[var(--ink)] active:cursor-grabbing">⋮⋮</button>
          : <span aria-hidden className="text-[11px] tracking-[-2px] text-[#c4bfae]">⋮⋮</span>}</td>;
        case "by": return <td key={col.key} className={`${one} w-[22px] px-[2px]`}>{row.drafted && <span title="Drafted by Setti" className="inline-flex"><BrandMark className="h-4 w-4" /></span>}</td>;
        case "item": return <td key={col.key} className={`${td} min-w-[210px]`}>
          <button type="button" disabled={!row.changeKey} onClick={() => row.changeKey && onSelect(row.changeKey)} className={`text-left text-[12.5px] font-semibold ${row.changeKey ? "hover:underline" : "cursor-default"} ${removed ? "text-[var(--muted)] line-through" : "text-[var(--ink)]"}`}>{row.name}</button>
          {chip && <span className={`ml-1.5 inline-block whitespace-nowrap rounded-[5px] px-1.5 py-px align-[1px] text-[10px] font-bold tracking-[0.02em] ${CHIP_STYLE[row.status]}`}>{row.status === "replaced" && row.replaces ? `Replaces ${row.replaces}` : chip}</span>}
          {row.questions.length > 0 && <button type="button" onClick={() => row.questions.forEach((issue) => toggleQuestion(issue.id))} aria-expanded={open}
            className={`ml-2 inline-flex items-center gap-0.5 whitespace-nowrap rounded px-0.5 text-[11px] font-semibold hover:bg-[var(--canvas)] ${answered ? "text-emerald-700" : "text-[#92400e]"}`}>
            {answered ? "Confirmed" : `${row.questions.length} ${row.questions.length === 1 ? "question" : "questions"}`}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>}
          {row.detail && <div className="max-w-[424px] text-[11.5px] text-[var(--muted)]">{row.detail}</div>}
        </td>;
        case "type": return <td key={col.key} className={`${one} text-[var(--muted)]`}>{row.type}</td>;
        case "supplier": return <td key={col.key} className={`${one} text-[var(--muted)]`}>{row.supplier}</td>;
        case "sku": return <td key={col.key} className={`${one} font-mono text-[11px]`}>{row.sku || "—"}</td>;
        case "source": return <td key={col.key} className={`${td} min-w-[150px] break-all font-mono text-[11px]`}>{row.source}</td>;
        case "unit": return <td key={col.key} className={`${one} text-[var(--muted)]`}>{row.unit}</td>;
        case "quantity": case "unitPriceCents": {
          const field = col.key;
          const price = field === "unitPriceCents";
          const old = price ? row.oldUnitPrice : row.oldQuantity;
          const value = valueOf(row, field);
          const key = row.changeKey;
          return <td key={col.key} className={`${one} text-right tabular-nums`}>
            {old !== null && !removed && <span className="block text-[10.5px] leading-[1.1] text-[var(--muted)] line-through">{price ? shortMoney(old) : old}</span>}
            {row.editable && key
              ? <EditCell value={value} money={price} marked={old !== null} disabled={disabled} label={`${row.name} ${price ? "unit price" : "quantity"}`} onCommit={(text) => onEdit(key, field, text)} />
              : <span className={removed ? "text-[var(--muted)] line-through" : ""}>{price ? row.unitPrice === null ? "Unknown" : shortMoney(row.unitPrice) : value}</span>}
          </td>;
        }
        case "total": return <td key={col.key} className={`${one} text-right tabular-nums`}>
          {removed && row.oldTotal !== null && <span className="block text-[10.5px] leading-[1.1] text-[var(--muted)] line-through">{shortMoney(row.oldTotal)}</span>}
          <b className="font-semibold">{row.total === null ? "—" : shortMoney(row.total)}</b>
        </td>;
        case "difference": return <td key={col.key} className={`${one} text-right font-medium tabular-nums ${tone(row.changeKey ? row.difference : 0)}`}>{row.changeKey ? signed(row.difference) : "—"}</td>;
        case "check": {
          const key = row.changeKey;
          return <td key={col.key} className={`${one} text-right`}>{row.checked !== null && key && <input type="checkbox" aria-label={`Checked ${row.name}`} checked={row.checked} disabled={disabled}
            onChange={(event) => onCheck([key], event.target.checked)} className="h-[15px] w-[15px] cursor-pointer accent-emerald-700" />}</td>;
        }
      }
    });
    // The landing place shows as a dark rule along the row's top or bottom edge.
    const landing = over && over.key === row.token && dragging && dragging !== row.token ? over.place : null;
    const edge = landing === "before" ? "inset 0 2px 0 #30362d" : landing === "after" ? "inset 0 -2px 0 #30362d" : null;
    const shown = edge ? cells.map((cell) => cloneElement(cell, { style: { ...cell.props.style, boxShadow: [cell.props.style?.boxShadow, edge].filter(Boolean).join(", ") } })) : cells;
    const key = row.token;
    return <tr key={row.id} className={`${row.changeKey && row.changeKey === selectedKey ? "bg-[#fffdf3]" : ""} ${dragging === key ? "opacity-50" : ""}`}
      onDragOver={onMove && dragging ? (event) => { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); const place = event.clientY < box.top + box.height / 2 ? "before" : "after"; if (over?.key !== key || over.place !== place) setOver({ key, place }); } : undefined}
      onDrop={onMove && dragging ? (event) => { event.preventDefault(); if (over && dragging !== key) onMove(dragging, key, over.place); setDragging(null); setOver(null); } : undefined}>{shown}</tr>;
  }

  function fee(row: FeeRow) {
    const cell = "border-b border-dashed border-[var(--line)] px-2 pb-1.5 pt-1 align-middle";
    return <tr key={row.id}>{cols.map((col, index) => {
      if (index === 0) return <td key={col.key} className={cell} style={{ boxShadow: `inset 3px 0 0 ${row.tone.bar}` }} />;
      if (col.key === "item") return <td key={col.key} className={cell}><button type="button" onClick={() => onSelect(row.changeKey)} className="flex flex-wrap items-center gap-1.5 pl-3.5 text-left text-[12px] text-slate-600">↳ {row.label}<span className="rounded-full bg-[#fdeceb] px-[7px] py-px text-[10px] font-bold text-[#9c3d34]">Not refundable</span></button></td>;
      if (col.key === "total") return <td key={col.key} className={`${cell} text-right tabular-nums`}>{row.amount === null ? <span className="text-[#92400e]">Enter it</span> : shortMoney(row.amount)}</td>;
      if (col.key === "difference") return <td key={col.key} className={`${cell} text-right font-medium tabular-nums ${tone(row.amount)}`}>{signed(row.amount)}</td>;
      return <td key={col.key} className={cell} />;
    })}</tr>;
  }

  function question(row: QuestionRow) {
    const done = row.issue.resolved;
    return <tr key={row.id}><td colSpan={cols.length} style={{ boxShadow: `inset 3px 0 0 ${row.tone.bar}` }} className={`whitespace-normal border-b border-dashed border-[var(--line)] py-[7px] pl-[50px] pr-2 ${done ? "bg-emerald-50/60" : "bg-[#fbfaf7]"}`}>
      <div className={`flex items-center gap-2 text-[12px] ${done ? "text-emerald-800" : "text-slate-600"}`}>
        {done ? <Check className="h-[15px] w-[15px] shrink-0" /> : <BrandMark className="h-[15px] w-[15px] shrink-0" />}
        <span className="min-w-0 flex-1"><b>{done ? "Confirmed" : "Setti asks"}:</b> {row.issue.label}</span>
        {done
          ? <button type="button" disabled={disabled} onClick={() => onResolve(row.issue.id, false)} className="text-[11.5px] font-semibold text-[var(--primary)] underline">Undo</button>
          : <button type="button" disabled={disabled} onClick={() => onResolve(row.issue.id, true)} className="rounded-md bg-[var(--ink)] px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-[#1f241d] disabled:opacity-50">Yes, confirmed</button>}
      </div>
    </td></tr>;
  }

  function group(head: GroupRow) {
    const open = !collapsed[head.id];
    const all = head.checkKeys.length > 0 && head.checked === head.checkKeys.length;
    const some = head.checked > 0 && !all;
    const cell = "border-b border-[var(--line)] px-2 py-2 align-middle font-semibold";
    const style = { background: head.tone.bg };
    return <tr>
      <td colSpan={totalAt} className={cell} style={{ ...style, boxShadow: `inset 3px 0 0 ${head.tone.bar}` }}>
        <span className="flex flex-wrap items-center gap-x-1.5">
          <button type="button" onClick={() => toggleGroup(head.id)} aria-expanded={open} className="inline-flex items-center gap-1.5 text-[12.5px] font-bold"><ChevronDown className={`h-[13px] w-[13px] transition-transform ${open ? "" : "-rotate-90"}`} />{head.name}</button>
          <span className="font-medium text-[var(--muted)]">{head.count} {head.count === 1 ? "item" : "items"}</span>
          {renameGroup && head.name !== "No section" && head.id !== "group:questions" && <button type="button" disabled={disabled} onClick={() => renameGroup(head.name)} className="rounded px-1 text-[11.5px] font-medium text-[var(--muted)] hover:bg-white/60 hover:text-[var(--ink)]">Rename</button>}
        </span>
      </td>
      <td className={`${cell} text-right tabular-nums`} style={style}>{head.subtotal === null ? "" : shortMoney(head.subtotal)}</td>
      {!first && <td className={`${cell} text-right tabular-nums ${tone(head.difference)}`} style={style}>{head.id === "group:questions" ? "" : signed(head.difference)}</td>}
      {after > 0 && <td colSpan={after} className={cell} style={style} />}
      {anyCheck && <td className={`${cell} text-right`} style={style}>{head.checkKeys.length > 0 && <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]" title={`Check every line Setti drafted in ${head.name}`}>
        All<input type="checkbox" checked={all} ref={(input) => { if (input) input.indeterminate = some; }} disabled={disabled}
          onChange={(event) => onCheck(head.checkKeys, event.target.checked)} aria-label={`Check all lines Setti drafted in ${head.name}`} className="h-[15px] w-[15px] cursor-pointer accent-emerald-700" /></label>}</td>}
    </tr>;
  }

  return <div className="overflow-hidden rounded-b-xl">
    {/* The table scrolls sideways in its own box; its width never widens the page around it. */}
    <div className="overflow-x-auto [contain:inline-size]">
      <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
        <thead><tr>{cols.map((col) => <th key={col.key} title={col.internal ? "Only you see this column. It never appears on the client's quote." : undefined}
          className={`whitespace-nowrap border-b border-[var(--line)] bg-white p-2 text-[10.5px] font-semibold tracking-[0.02em] text-[var(--muted)] ${col.right ? "text-right" : "text-left"}`}>
          {col.internal && <EyeOff aria-hidden className="mr-[3px] inline h-3 w-3 align-[-2px]" />}{col.label}{col.internal && <span className="sr-only"> (not shown to the client)</span>}</th>)}</tr></thead>
        {groups.map(({ head, rows: members }) => <tbody key={head.id}>
          {group(head)}
          {members.map((row) => row.kind === "line" ? line(row) : row.kind === "fee" ? fee(row) : row.kind === "question" ? question(row) : null)}
          {addTo && !collapsed[head.id] && head.name !== "No section" && <tr><td colSpan={cols.length} className="border-b border-[var(--line)] py-[5px] pl-[50px] pr-2" style={{ boxShadow: `inset 3px 0 0 ${head.tone.bar}` }}>
            <button type="button" disabled={disabled} onClick={() => addTo(head.name)} className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]">+ Add item</button></td></tr>}
        </tbody>)}
      </table>
    </div>
  </div>;
}

type Col = { key: "grip" | "by" | "item" | keyof ItemsColumns | "unit" | "quantity" | "unitPriceCents" | "total" | "difference" | "check"; label: string; right?: boolean; internal?: boolean };
const tone = (value: number | null) => value === null || value === 0 ? "text-[var(--muted)]" : value > 0 ? "text-[#9c3d34]" : "text-emerald-700";
const signed = (value: number | null) => value === null || value === 0 ? "—" : `${value > 0 ? "+" : "−"}${shortMoney(Math.abs(value))}`;

/**
 * A number the designer edits in place, as in the plan: plain text until hovered,
 * marked yellow when it differs from the signed version. The typed text is
 * committed on Enter or when the cell loses focus; Escape puts it back.
 */
function EditCell({ value, money, marked, disabled, label, onCommit }: { value: string; money: boolean; marked: boolean; disabled: boolean; label: string; onCommit: (text: string) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = typing ?? (money && value !== "" && Number.isFinite(Number(value)) ? shortMoney(Math.round(Number(value) * 100)) : value);
  return <input aria-label={label} value={shown} disabled={disabled} inputMode="decimal"
    onFocus={(event) => { cancelled.current = false; setTyping(value); const input = event.target; requestAnimationFrame(() => input.select()); }}
    onChange={(event) => setTyping(event.target.value)}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { cancelled.current = true; event.currentTarget.blur(); } }}
    onBlur={() => { const text = typing; setTyping(null); if (!cancelled.current && text !== null && text !== value) onCommit(text); }}
    className={`w-[76px] rounded-md border border-transparent px-1.5 py-[3px] text-right tabular-nums text-[var(--ink)] outline-none hover:border-[var(--line)] hover:bg-white focus:border-[#cfcab9] focus:bg-white disabled:hover:border-transparent ${marked ? "bg-[#fff3c4]" : "bg-transparent"}`} />;
}

function feeLabel(kind: string): string {
  return ({ restocking_fee: "Restocking fee", fabrication_fee: "Fabrication fee", shipping: "Return shipping", material_cost: "Material cost", cancellation_fee: "Cancellation fee", other: "Other cost" } as Record<string, string>)[kind] ?? "Cost the supplier keeps";
}

const CHIP: Record<Status, string | null> = { same: null, new: "New", changed: "Changed", replaced: "Replaces", removed: "Removed" };
const CHIP_STYLE: Record<Status, string> = {
  same: "", new: "bg-[#eef6ff] text-[#1d4f91]", changed: "bg-[#fff3c4] text-[var(--primary)]", replaced: "bg-[#eef6ff] text-[#1d4f91]", removed: "bg-[#fdf1f0] text-[#9c3d34]",
};
