"use client";

import { AllCommunityModule, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Check, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import type { PricingChangeInput } from "@/pricing/types";
import type { ApprovedQuoteLine } from "@/quotes/types";
import { centsText, pricingTheme } from "./common";

export type EditableGridField = "name" | "vendor" | "sku" | "quantity" | "unitLabel" | "unitPriceCents" | "taxCents" | "freightCents";
export type RawFields = Record<string, string>;
export function fieldKey(key: string, field: string): string { return `${key}:${field}`; }

interface PricingRow {
  key: string;
  action: string;
  name: string;
  vendor: string;
  sku: string;
  quantity: string;
  unitLabel: string;
  currency: string;
  unitPriceCents: string;
  taxCents: string;
  freightCents: string;
  hasAfter: boolean;
  confirmed: string;
}

const modules = [AllCommunityModule];
// The item name opens the details drawer, so it is edited there rather than in the grid.
const editableFields: EditableGridField[] = ["vendor", "sku", "quantity", "unitLabel", "unitPriceCents", "taxCents", "freightCents"];
const quantityIdentityFields = new Set(["name", "vendor", "sku", "unitLabel"]);

function OpenDetails({ value }: ICellRendererParams<PricingRow, string>) {
  return <span className="inline-flex max-w-full items-center gap-1 font-medium text-[var(--primary)] hover:underline"><span className="truncate">{value}</span><ChevronRight className="h-3.5 w-3.5 shrink-0" /></span>;
}

/** Each row's visible way into its details: review it, or view it once checked. */
function CheckButton({ data }: ICellRendererParams<PricingRow, string>) {
  const checked = data?.confirmed === "Reviewed";
  return <span className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold leading-4 ${checked ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-[var(--primary-fill)] text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"}`}>
    {checked ? <><Check className="h-3 w-3" />Checked · View</> : <>Review<ChevronRight className="h-3 w-3" /></>}
  </span>;
}

export function PricingGrid({ changes, baselineLines, raw, disabled, selectedKey, onSelect, onEdit }: { changes: PricingChangeInput[]; baselineLines: readonly Pick<ApprovedQuoteLine, "itemId" | "name" | "vendor" | "sku">[]; raw: RawFields; disabled: boolean; selectedKey: string | null; onSelect: (key: string) => void; onEdit: (key: string, field: EditableGridField, value: string) => void }) {
  const rows = useMemo<PricingRow[]>(() => changes.map((change) => {
    const before = baselineLines.find((line) => line.itemId === change.itemId);
    return {
      key: change.key, action: change.action, name: change.after?.name ?? before?.name ?? "Original item", vendor: change.after?.vendor ?? before?.vendor ?? "", sku: change.after?.sku ?? before?.sku ?? "",
      quantity: raw[fieldKey(change.key, "quantity")] ?? (change.after ? String(change.after.quantity) : ""), unitLabel: change.after?.unitLabel ?? "", currency: change.after?.currency ?? "Unconfirmed",
      unitPriceCents: raw[fieldKey(change.key, "unitPriceCents")] ?? centsText(change.after?.unitPriceCents ?? null),
      taxCents: raw[fieldKey(change.key, "taxCents")] ?? centsText(change.after?.taxCents ?? null),
      freightCents: raw[fieldKey(change.key, "freightCents")] ?? centsText(change.after?.freightCents ?? null),
      hasAfter: change.after !== null, confirmed: change.confirmed ? "Reviewed" : "Needs review",
    };
  }), [changes, baselineLines, raw]);
  const canEdit = (data: PricingRow | undefined, field: string | undefined) => !disabled && Boolean(data?.hasAfter) && editableFields.includes(field as EditableGridField) && !(data?.action === "quantity" && quantityIdentityFields.has(field ?? ""));
  const columns = useMemo<ColDef<PricingRow>[]>(() => [
    { field: "action", headerName: "Change", width: 105, cellClass: "cursor-pointer" },
    { field: "name", headerName: "Item / replacement", minWidth: 190, flex: 2, pinned: "left", cellClass: "cursor-pointer", cellRenderer: OpenDetails },
    { field: "vendor", headerName: "Seller", minWidth: 135 },
    { field: "sku", headerName: "SKU / reference", minWidth: 130 },
    { field: "quantity", headerName: "Qty", width: 85 },
    { field: "unitLabel", headerName: "Purchase unit", minWidth: 120 },
    { field: "currency", headerName: "Currency", minWidth: 110, cellClass: "cursor-pointer" },
    { field: "unitPriceCents", headerName: "Unit price", minWidth: 125 },
    { field: "taxCents", headerName: "Line tax", minWidth: 110 },
    { field: "freightCents", headerName: "Line delivery", minWidth: 125 },
    { field: "confirmed", headerName: "Designer check", minWidth: 150, pinned: "right", cellClass: "cursor-pointer", cellRenderer: CheckButton },
  ], []);
  return <div className="overflow-hidden rounded-xl border border-slate-200"><div className="h-[295px] w-full"><AgGridReact<PricingRow> modules={modules} theme={pricingTheme} rowData={rows} columnDefs={columns} defaultColDef={{ editable: ({ data, colDef }) => canEdit(data, colDef.field), resizable: true, sortable: true, cellDataType: false }} readOnlyEdit getRowId={({ data }) => data.key} rowHeight={44} headerHeight={42} getRowStyle={({ data }) => data?.key === selectedKey ? { backgroundColor: "var(--primary-soft)" } : undefined} onCellClicked={({ data, colDef }) => { if (data && !canEdit(data, colDef.field)) onSelect(data.key); }} onCellKeyDown={(params) => { if ("colDef" in params && params.data && params.event instanceof KeyboardEvent && params.event.key === "Enter" && !canEdit(params.data, params.colDef.field)) onSelect(params.data.key); }} onCellEditRequest={({ data, colDef, newValue }) => { if (data && canEdit(data, colDef.field)) onEdit(data.key, colDef.field as EditableGridField, String(newValue ?? "")); }} singleClickEdit stopEditingWhenCellsLoseFocus enableCellTextSelection /></div><p className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-500">Select Review, or an item name, to open all its details, terms and the designer check. Supplier, quantity and price cells can also be edited right here. Tax and delivery are totals for the whole line; empty amounts remain unknown.</p></div>;
}
