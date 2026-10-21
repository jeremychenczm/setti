"use client";

import { AllCommunityModule, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import type { PricingChangeInput } from "@/pricing/types";
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
const editableFields: EditableGridField[] = ["name", "vendor", "sku", "quantity", "unitLabel", "unitPriceCents", "taxCents", "freightCents"];
const quantityIdentityFields = new Set(["name", "vendor", "sku", "unitLabel"]);

export function PricingGrid({ changes, raw, disabled, selectedKey, onSelect, onEdit }: { changes: PricingChangeInput[]; raw: RawFields; disabled: boolean; selectedKey: string | null; onSelect: (key: string) => void; onEdit: (key: string, field: EditableGridField, value: string) => void }) {
  const rows = useMemo<PricingRow[]>(() => changes.map((change) => ({
    key: change.key, action: change.action, name: change.after?.name ?? "Remove original item", vendor: change.after?.vendor ?? "", sku: change.after?.sku ?? "",
    quantity: raw[fieldKey(change.key, "quantity")] ?? (change.after ? String(change.after.quantity) : ""), unitLabel: change.after?.unitLabel ?? "", currency: change.after?.currency ?? "Unconfirmed",
    unitPriceCents: raw[fieldKey(change.key, "unitPriceCents")] ?? centsText(change.after?.unitPriceCents ?? null),
    taxCents: raw[fieldKey(change.key, "taxCents")] ?? centsText(change.after?.taxCents ?? null),
    freightCents: raw[fieldKey(change.key, "freightCents")] ?? centsText(change.after?.freightCents ?? null),
    hasAfter: change.after !== null, confirmed: change.confirmed ? "Reviewed" : "Needs review",
  })), [changes, raw]);
  const columns = useMemo<ColDef<PricingRow>[]>(() => [
    { field: "action", headerName: "Change", width: 105, editable: false },
    { field: "name", headerName: "Proposed item", minWidth: 190, flex: 2, pinned: "left" },
    { field: "vendor", headerName: "Seller", minWidth: 135 },
    { field: "sku", headerName: "SKU / reference", minWidth: 130 },
    { field: "quantity", headerName: "Qty", width: 85 },
    { field: "unitLabel", headerName: "Purchase unit", minWidth: 120 },
    { field: "currency", headerName: "Currency", minWidth: 110, editable: false },
    { field: "unitPriceCents", headerName: "Unit price", minWidth: 125 },
    { field: "taxCents", headerName: "Line tax", minWidth: 110 },
    { field: "freightCents", headerName: "Line delivery", minWidth: 125 },
    { field: "confirmed", headerName: "Designer check", minWidth: 135, editable: false },
  ], []);
  return <div className="overflow-hidden rounded-xl border border-slate-200"><div className="h-[295px] w-full"><AgGridReact<PricingRow> modules={modules} theme={pricingTheme} rowData={rows} columnDefs={columns} defaultColDef={{ editable: ({ data, colDef }) => !disabled && Boolean(data?.hasAfter) && !(data?.action === "quantity" && quantityIdentityFields.has(colDef.field ?? "")), resizable: true, sortable: true, cellDataType: false }} readOnlyEdit getRowId={({ data }) => data.key} rowHeight={44} headerHeight={42} getRowStyle={({ data }) => data?.key === selectedKey ? { backgroundColor: "#eff6ff" } : undefined} onRowClicked={({ data }) => { if (data) onSelect(data.key); }} onCellEditRequest={({ data, colDef, newValue }) => { if (data && colDef.field && editableFields.includes(colDef.field as EditableGridField) && !(data.action === "quantity" && quantityIdentityFields.has(colDef.field))) onEdit(data.key, colDef.field as EditableGridField, String(newValue ?? "")); }} singleClickEdit stopEditingWhenCellsLoseFocus enableCellTextSelection /></div><p className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-500">Edit proposed values in the grid, or select a row and use the fields below. Tax and delivery are totals for the whole line. Empty amounts remain unknown.</p></div>;
}
