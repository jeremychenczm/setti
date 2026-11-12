"use client";

import { AllCommunityModule, type CellClassParams, type CellKeyDownEvent, type ColDef, type FullWidthCellKeyDownEvent, type GridApi, type ICellRendererParams, type RowSelectionOptions, type ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxView } from "@/payments/inbox-view";
import { part } from "../money/desk-view";
import { confirmation, EVENT_VERB, itemNote, itemRows, lastConfirmed, newBatches, usd, when, type ItemRow } from "./inbox-rows";
import { InboxPopover } from "./InboxPopover";
import { CARD, InboxFrame, inboxTheme, NewMark, SearchBox, Summary, Swatch, Tile } from "./parts";

const modules = [AllCommunityModule];
const selection: RowSelectionOptions<ItemRow> = { mode: "singleRow", checkboxes: false, enableClickSelection: false };

/** The grid's pinned last row: the totals. */
interface Total { id: "total"; total: true; label: string; heldCents: number; chargedCents: number; refundedCents: number }
const isTotal = (data: unknown): data is Total => !!data && (data as Total).total === true;

function ItemCell({ data }: ICellRendererParams<ItemRow>) {
  if (isTotal(data)) return <span className="font-semibold">Total</span>;
  return data ? <span className="flex h-full min-w-0 items-center leading-tight"><span className="truncate font-semibold">{data.label}</span>{data.isNew && <NewMark />}</span> : null;
}

function StatusCell({ data }: ICellRendererParams<ItemRow>) {
  if (!data || isTotal(data)) return null;
  const p = part(data.part);
  return <span className="flex h-full items-center leading-tight"><span className="whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold leading-4" style={{ background: p.soft, color: p.softInk }}>{data.status}</span></span>;
}

const amount = ({ value, node }: ValueFormatterParams<ItemRow, number>) => value || node?.rowPinned ? usd(value ?? 0) : "—";
/** Rules, so the right-aligned column type keeps its own class. */
const amountClass = {
  "font-semibold": ({ node }: CellClassParams<ItemRow, number>) => !!node.rowPinned,
  "text-[var(--muted)]": ({ node, value }: CellClassParams<ItemRow, number>) => !node.rowPinned && !value,
};

function OpenCell({ data }: ICellRendererParams<ItemRow>) {
  return data && !isTotal(data) ? <span className="flex h-full items-center justify-end text-[var(--muted)]"><ChevronRight aria-hidden className="h-4 w-4" /></span> : null;
}

const itemsLabel = (n: number) => n ? `${n} ${n === 1 ? "item" : "items"}` : undefined;

/**
 * Emma's inbox: where her money stands, laid out like the studio's Money page.
 * One grid row per item; an item opens its PayPal records, each with its PayPal
 * id and how PayPal confirmed it. Beside it, what is new since her last visit
 * (nothing is new on a first visit) and Setti's summary.
 */
export function ClientInbox({ view, fresh, firstVisit, error }: { view: InboxView; fresh: ReadonlySet<string>; firstVisit: boolean; error: string | null }) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const grid = useRef<GridApi<ItemRow> | null>(null);
  const card = useRef<HTMLElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => itemRows(view, fresh), [view, fresh]);
  const open = rows.find((row) => row.id === openId) ?? null;
  const totals = view.totals ?? { heldCents: 0, chargedCents: 0, refundedCents: 0 };
  const pinned = useMemo<Total[]>(() => rows.length ? [{ id: "total", total: true, label: "Total", heldCents: 0, chargedCents: 0, refundedCents: 0, ...view.totals }] : [], [rows.length, view.totals]);
  const checked = lastConfirmed(view.events);
  const batches = useMemo(() => newBatches(view.events.filter((event) => fresh.has(event.id))), [view.events, fresh]);

  const columns = useMemo<ColDef<ItemRow>[]>(() => [
    { field: "label", headerName: "Item", flex: 2, minWidth: 180, cellRenderer: ItemCell },
    { field: "status", headerName: "Status", flex: 1, minWidth: 130, cellRenderer: StatusCell },
    { field: "heldCents", headerName: "On hold", width: 120, type: "rightAligned", initialSort: "desc", sortingOrder: ["desc", "asc", null], valueFormatter: amount, cellClassRules: amountClass, getQuickFilterText: () => "" },
    { field: "chargedCents", headerName: "Charged", width: 120, type: "rightAligned", sortingOrder: ["desc", "asc", null], valueFormatter: amount, cellClassRules: amountClass, getQuickFilterText: () => "" },
    { field: "refundedCents", headerName: "Refunded", width: 120, type: "rightAligned", sortingOrder: ["desc", "asc", null], valueFormatter: amount, cellClassRules: amountClass, getQuickFilterText: () => "" },
    { colId: "open", headerName: "", width: 40, sortable: false, resizable: false, cellRenderer: OpenCell, getQuickFilterText: () => "" },
  ], []);

  const toggle = useCallback((id: string) => setOpenId((current) => current === id ? null : id), []);
  const closePopover = useCallback(() => setOpenId(null), []);
  const rowElement = useCallback(() => openId ? wrap.current?.querySelector<HTMLElement>(`[row-id="${CSS.escape(openId)}"]`) ?? null : null, [openId]);
  const cardElement = useCallback(() => card.current, []);
  const inGridRow = useCallback((target: Element) => !!wrap.current?.contains(target) && !!target.closest(".ag-row"), []);
  useEffect(() => {
    const api = grid.current;
    if (!api) return;
    const node = open ? api.getRowNode(open.id) : undefined;
    if (node) node.setSelected(true, true); else api.deselectAll();
  }, [open]);
  const onKey = (event: CellKeyDownEvent<ItemRow> | FullWidthCellKeyDownEvent<ItemRow>) => {
    const key = event.event instanceof KeyboardEvent ? event.event.key : "";
    if (key === "Enter" && event.data && !event.node.rowPinned) { event.event?.preventDefault(); toggle(event.data.id); }
  };

  if (!view.project) return <InboxFrame subtitle="Where your money stands, as PayPal records it." error={error}><p className="text-[12px] text-[var(--muted)]">No project is linked to this account.</p></InboxFrame>;
  const count = (key: "heldCents" | "chargedCents" | "refundedCents") => view.items.filter((item) => item[key] > 0).length;
  const shownAmount = (row: ItemRow) => row.heldCents || row.refundedCents || row.chargedCents || row.releasedCents;

  return <InboxFrame subtitle={`Where your money for ${view.project.name} stands, as PayPal records it.`} error={error}>
    <div className="grid grid-cols-12 gap-3">
      <Tile mark={<Swatch id="held" />} label="On hold now" corner={itemsLabel(count("heldCents"))} value={usd(totals.heldCents)} note="Charged after each supplier confirms" />
      <Tile mark={<Swatch id="kept" />} label="Charged" corner={itemsLabel(count("chargedCents"))} value={usd(totals.chargedCents)} note="Captured by PayPal" />
      <Tile mark={<Swatch id="refunded" />} label="Refunded" corner={itemsLabel(count("refundedCents"))} value={usd(totals.refundedCents)} note={totals.refundedCents ? "Returned to you through PayPal" : "Comes after a supplier credit"} />
      <Tile mark={<Swatch id="notFunded" />} label="Checked with PayPal" small value={checked ? when(checked.at) : "Not yet"}
        note={!checked ? "Nothing has been confirmed by PayPal yet" : checked.via === "webhook" ? "PayPal confirmed it to Setti" : checked.via === "readback" ? "Setti read it back from PayPal" : "From PayPal's response"} />

      <section ref={card} aria-labelledby="items-title" className={`${CARD} col-span-12 grid content-start gap-3 xl:col-span-8`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="items-title" className="text-[13px] font-semibold">Your items <span className="font-normal text-[var(--muted)]">· {rows.length}</span></h2>
          {rows.length > 0 && <SearchBox label="Search items" value={query} onChange={setQuery} />}
        </div>
        {rows.length === 0 ? <p className="text-[12px] text-[var(--muted)]">Nothing has been charged or held yet.</p>
          : <div ref={wrap} className="overflow-hidden rounded-[10px] border border-[var(--line)]">
            <AgGridReact<ItemRow>
              modules={modules} theme={inboxTheme} rowData={rows} columnDefs={columns}
              defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
              getRowId={({ data }) => data.id} domLayout="autoHeight" rowHeight={44} headerHeight={38}
              quickFilterText={query} pinnedBottomRowData={pinned} rowSelection={selection} animateRows={false} ensureDomOrder
              onGridReady={({ api }) => { grid.current = api; }}
              onRowClicked={({ data, node }) => { if (data && !node.rowPinned) toggle(data.id); }}
              onCellKeyDown={onKey}
              overlayNoRowsTemplate="<span>No item matches. Clear the search.</span>"
            />
          </div>}
        <p className="text-[11px] text-[var(--muted)]">Sort any column, search, or select an item for its PayPal records · AG Grid Community</p>
      </section>

      <div className="col-span-12 grid content-start gap-3 xl:col-span-4">
        {(!firstVisit || batches.length > 0) && <section aria-labelledby="new-since" className={`${CARD} grid gap-2.5`}>
          <h2 id="new-since" className="text-[12px] font-semibold text-slate-600">New since your last visit</h2>
          {batches.length === 0 ? <p className="text-[12px] text-[var(--muted)]">Nothing new since your last visit.</p>
            : batches.map((batch) => <div key={batch.key} className="grid gap-0.5">
              <p className="flex flex-wrap items-baseline gap-x-2.5 text-[12px] font-semibold"><span>{batch.title}</span><span className="ml-auto tabular-nums">{usd(batch.totalCents)}</span></p>
              <p className="text-[12px] leading-relaxed text-slate-600">{batch.names}. {batch.confirmation}</p>
            </div>)}
        </section>}
        <Summary view={view} />
      </div>
    </div>

    {open && <InboxPopover key={open.id} anchor={rowElement} beside={cardElement} onClose={closePopover} keepOpen={inGridRow}
      title={open.label} subtitle={`${open.status} · ${usd(shownAmount(open))}`}>
      <p className="leading-relaxed text-[var(--muted)]">{itemNote(open)}</p>
      {open.events.length === 0 ? <p className="text-[var(--muted)]">No PayPal record of this item yet.</p>
        : <ul className="border-t border-[var(--line)]">{open.events.map((event) => {
          const confirmed = confirmation(event.checked);
          return <li key={event.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-px border-b border-[var(--line)] py-2">
            <span className="text-[13px] font-semibold">{EVENT_VERB[event.kind]}{fresh.has(event.id) && <NewMark />}</span>
            <span className="text-right font-medium tabular-nums">{usd(event.amountCents)}</span>
            <span className="col-span-2 text-[11px] text-[var(--muted)]">{when(event.at)}{event.paypalId && <> · PayPal <span className="font-mono">{event.paypalId}</span></>}</span>
            <span className={`col-span-2 text-[11px] ${confirmed.confirmed ? "text-emerald-700" : "text-amber-700"}`}>{confirmed.text}</span>
          </li>;
        })}</ul>}
    </InboxPopover>}
  </InboxFrame>;
}
