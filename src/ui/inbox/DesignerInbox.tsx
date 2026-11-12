"use client";

import { AllCommunityModule, type CellKeyDownEvent, type ColDef, type FullWidthCellKeyDownEvent, type GridApi, type ICellRendererParams, type IRowNode, type RowSelectionOptions } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttentionItem } from "@/payments/attention";
import type { InboxView } from "@/payments/inbox-view";
import { part } from "../money/desk-view";
import { DailyCheck } from "./DailyCheck";
import { ACTION, byKind, projectRows, REASON, rowShown, tiles, usd, waitingText, type Bucket, type ProjectRow, type Tile as TileData } from "./inbox-rows";
import { InboxPopover } from "./InboxPopover";
import { CARD, Dot, FOCUS, InboxFrame, inboxTheme, NewMark, SearchBox, SimulatedDay, Summary, Swatch, Tile } from "./parts";

const modules = [AllCommunityModule];
const selection: RowSelectionOptions<ProjectRow> = { mode: "singleRow", checkboxes: false, enableClickSelection: false };

/** The grid's pinned last row: what the rows shown add up to, its note in What to do. */
interface Total { id: "total"; total: true; count: number; todo: string; heldCents: number; toRefundCents: number }
const isTotal = (data: unknown): data is Total => !!data && (data as Total).total === true;

function ProjectCell({ data }: ICellRendererParams<ProjectRow>) {
  if (isTotal(data)) return <span className="font-semibold">Total</span>;
  if (!data) return null;
  return <span className="flex h-full min-w-0 items-center gap-1.5 leading-tight"><span className="truncate font-semibold">{data.name}</span>{data.isNew && <NewMark />}</span>;
}

const dayOf = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
/** What Setti waits for when nothing needs the designer: held items, and the day the first one needs its supplier order. */
function watchingText(watching: InboxView["watching"]): string | null {
  if (!watching?.count) return null;
  const items = `${watching.count} held ${watching.count === 1 ? "item" : "items"}`;
  return `Setti is watching ${items} on ${watching.projects.join(", ")}. Any still not ordered when PayPal's 3-day honor period ends${watching.until ? `, on ${dayOf(watching.until)},` : ""} shows up here.`;
}

function StageCell({ data }: ICellRendererParams<ProjectRow>) {
  return data && !isTotal(data) ? <span title={data.stage} className="flex h-full items-center leading-tight text-[var(--muted)]"><span className="line-clamp-2 whitespace-normal">{data.stage}</span></span> : null;
}

function CountCell({ data }: ICellRendererParams<ProjectRow>) {
  if (isTotal(data)) return <span className="font-semibold tabular-nums">{data.count}</span>;
  return data ? <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d7262e] px-1.5 text-[11px] font-bold text-white tabular-nums">{data.count}</span> : null;
}

function TodoCell({ data }: ICellRendererParams<ProjectRow>) {
  return <span className={`flex h-full items-center ${isTotal(data) ? "text-[var(--muted)]" : ""}`}><span className="line-clamp-2 whitespace-normal leading-snug">{data?.todo}</span></span>;
}

function WaitingCell({ data }: ICellRendererParams<ProjectRow>) {
  if (isTotal(data)) return <span className="font-semibold tabular-nums">{waitingText(data.heldCents, data.toRefundCents)}</span>;
  if (!data) return null;
  const text = waitingText(data.heldCents, data.toRefundCents);
  return <span className="flex h-full flex-col justify-center gap-[3px]">
    <span role="img" aria-label={text} className="flex h-2 w-[120px] overflow-hidden rounded-[2px] bg-[#ebe9e2]">
      <span style={{ width: `${(data.toRefundShare * 100).toFixed(1)}%`, background: part("toRefund").fill }} />
      <span style={{ width: `${(data.heldShare * 100).toFixed(1)}%`, background: part("held").fill }} />
    </span>
    <span aria-hidden className="whitespace-nowrap text-[11px] leading-none text-slate-600 tabular-nums">{text}</span>
  </span>;
}

function OpenCell({ data }: ICellRendererParams<ProjectRow>) {
  return data && !isTotal(data) ? <span className="flex h-full items-center justify-end text-[var(--muted)]"><ChevronRight aria-hidden className="h-4 w-4" /></span> : null;
}

/** What an item's amount is, when the quote names no supplier for it. */
const PART_NOTE: Record<AttentionItem["amount"]["part"], string> = { held: "On hold", toRefund: "To refund after the credit", approved: "Approved; nothing is held now" };

function tileNote(tile: TileData): string {
  switch (tile.id) {
    case "confirm": return tile.count ? `${usd(tile.heldCents)} held${tile.confirmed ? "" : ", waiting on suppliers"}` : "Nothing to confirm or charge";
    case "credit": return tile.count ? `${usd(tile.toRefundCents)} to refund` : "No supplier credit is pending";
    case "holds": return "Expiring, expired or not renewed";
    case "paypal": return "Result unknown or the hold failed";
  }
}

const projectsLabel = (n: number) => `${n} ${n === 1 ? "project" : "projects"}`;

/**
 * Jordan's inbox, laid out like Money: what needs him grouped into four tiles,
 * one grid row per project, and Setti's summary, the daily check and what is
 * coming up beside it. A row opens its to-dos, each kind's reason said once.
 */
export function DesignerInbox({ view, fresh, error }: { view: InboxView; fresh: ReadonlySet<string>; error: string | null }) {
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState({ rows: 0, count: 0, heldCents: 0, toRefundCents: 0 });
  const grid = useRef<GridApi<ProjectRow> | null>(null);
  const card = useRef<HTMLElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const reminders = view.reminders;
  const tileList = useMemo(() => tiles(reminders), [reminders]);
  const rows = useMemo(() => projectRows(view, { bucket }, fresh), [view, bucket, fresh]);
  const needing = rows.filter(rowShown).length;
  const inSource = view.projects.length;
  const soon = reminders.filter((item) => item.urgency === "soon");
  const open = rows.find((row) => row.id === openId && rowShown(row)) ?? null;
  const watching = watchingText(view.watching);

  const isExternalFilterPresent = useCallback(() => true, []);
  // Hides rows with nothing in the picked tile.
  const doesExternalFilterPass = useCallback((node: IRowNode<ProjectRow>) => !!node.data && rowShown(node.data), []);
  const sumShown = useCallback((api: GridApi<ProjectRow>) => {
    const next = { rows: 0, count: 0, heldCents: 0, toRefundCents: 0 };
    api.forEachNodeAfterFilter((node) => {
      if (!node.data) return;
      next.rows += 1; next.count += node.data.count; next.heldCents += node.data.heldCents; next.toRefundCents += node.data.toRefundCents;
    });
    setShown((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  const rest = inSource - shown.rows;
  const note = query ? `${shown.rows} of ${projectsLabel(needing)} match the search.`
    : bucket ? `${projectsLabel(shown.rows)} in this tile.`
      : `${shown.rows} of ${projectsLabel(inSource)}.${rest > 0 ? ` The other ${rest === 1 ? "one needs" : `${rest} need`} nothing today.` : ""}`;
  const pinned = useMemo<Total[]>(() => shown.rows ? [{ id: "total", total: true, count: shown.count, todo: note, heldCents: shown.heldCents, toRefundCents: shown.toRefundCents }] : [], [shown, note]);

  const columns = useMemo<ColDef<ProjectRow>[]>(() => [
    { field: "name", headerName: "Project", flex: 1.7, minWidth: 185, cellRenderer: ProjectCell, getQuickFilterText: ({ data }) => data?.search ?? "" },
    { field: "stage", headerName: "Stage", flex: 1.1, minWidth: 130, cellRenderer: StageCell },
    { field: "count", headerName: "To do", width: 84, type: "rightAligned", initialSort: "desc", sortingOrder: ["desc", "asc", null], cellRenderer: CountCell },
    { field: "todo", headerName: "What to do", flex: 1.5, minWidth: 160, cellRenderer: TodoCell },
    { colId: "waiting", headerName: "Waiting", width: 185, sortingOrder: ["desc", "asc", null], valueGetter: ({ data }) => data ? data.heldCents + data.toRefundCents : 0, cellRenderer: WaitingCell, colSpan: ({ node }) => node?.rowPinned ? 2 : 1, getQuickFilterText: () => "" },
    { colId: "open", headerName: "", width: 40, sortable: false, resizable: false, cellRenderer: OpenCell, getQuickFilterText: () => "" },
  ], []);

  const toggle = useCallback((id: string) => setOpenId((current) => current === id ? null : id), []);
  const closePopover = useCallback(() => setOpenId(null), []);
  const rowElement = useCallback(() => openId ? wrap.current?.querySelector<HTMLElement>(`[row-id="${CSS.escape(openId)}"]`) ?? null : null, [openId]);
  const cardElement = useCallback(() => card.current, []);
  const inGridRow = useCallback((target: Element) => !!wrap.current?.contains(target) && !!target.closest(".ag-row"), []);
  // The open project is the grid's selected row.
  useEffect(() => {
    const api = grid.current;
    if (!api) return;
    const node = open ? api.getRowNode(open.id) : undefined;
    if (node) node.setSelected(true, true); else api.deselectAll();
  }, [open]);

  const onKey = (event: CellKeyDownEvent<ProjectRow> | FullWidthCellKeyDownEvent<ProjectRow>) => {
    const key = event.event instanceof KeyboardEvent ? event.event.key : "";
    if (key === "Enter" && event.data && !event.node.rowPinned) { event.event?.preventDefault(); toggle(event.data.id); }
  };

  const subtitle = view.projects.length === 1 ? "Setti watches the money in your project and lists what needs you."
    : "Setti watches the money in your projects and lists what needs you.";
  const tools = <SimulatedDay days={view.simulatedDays} />;

  return <InboxFrame subtitle={subtitle} tools={tools} error={error}>
    <div className="grid grid-cols-12 gap-3">
      {tileList.map((tile) => <Tile key={tile.id} label={tile.label} value={String(tile.count)} note={tileNote(tile)} hot={tile.count > 0}
        mark={tile.id === "confirm" ? <Swatch id="held" /> : tile.id === "credit" ? <Swatch id="toRefund" /> : <Dot on={tile.count > 0} />}
        corner={tile.projects ? projectsLabel(tile.projects) : undefined} pressed={bucket === tile.id} onClick={() => setBucket((current) => current === tile.id ? null : tile.id)} />)}

      <section ref={card} aria-labelledby="projects-title" className={`${CARD} col-span-12 grid content-start gap-3 xl:col-span-8`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="projects-title" className="text-[13px] font-semibold">Projects that need you <span className="font-normal text-[var(--muted)]">· {needing}</span>{bucket && <span className="font-normal text-[var(--muted)]"> · {tileList.find((tile) => tile.id === bucket)?.label}</span>}</h2>
          {view.reminders.length > 0 && <SearchBox label="Search projects or items" value={query} onChange={setQuery} />}
        </div>
        {view.reminders.length === 0
          ? <div className="grid gap-1.5 rounded-[10px] border border-[var(--line)] px-4 py-5"><p className="text-[14px] font-semibold">Nothing needs you today.</p><p className="text-[13px] leading-relaxed text-slate-600">{watching ?? "Setti checks every project's holds, charges and refunds and lists here what needs your attention."}</p></div>
          : <div ref={wrap} className="overflow-hidden rounded-[10px] border border-[var(--line)]">
            <AgGridReact<ProjectRow>
              modules={modules} theme={inboxTheme} rowData={rows} columnDefs={columns}
              defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
              getRowId={({ data }) => data.id} domLayout="autoHeight" rowHeight={56} headerHeight={38}
              quickFilterText={query} isExternalFilterPresent={isExternalFilterPresent} doesExternalFilterPass={doesExternalFilterPass}
              pinnedBottomRowData={pinned} rowSelection={selection} animateRows={false} ensureDomOrder
              onGridReady={({ api }) => { grid.current = api; sumShown(api); }}
              onModelUpdated={({ api }) => sumShown(api)}
              onRowClicked={({ data, node }) => { if (data && !node.rowPinned) toggle(data.id); }}
              onCellKeyDown={onKey}
              overlayNoRowsTemplate="<span>No project matches. Clear the search, or pick another tile or filter.</span>"
            />
          </div>}
        <p className="text-[11px] text-[var(--muted)]">Sort any column, search, or select a project for its to-dos · AG Grid Community</p>
      </section>

      <div className="col-span-12 grid content-start gap-3 xl:col-span-4">
        <Summary view={view} />
        <DailyCheck check={view.lastCheck} live={view.projects.length} />
        <section aria-labelledby="coming-up" className={`${CARD} grid gap-2`}>
          <h2 id="coming-up" className="text-[12px] font-semibold text-slate-600">Coming up</h2>
          {soon.length === 0 ? <p className="text-[12px] leading-relaxed text-[var(--muted)]">Nothing in the next few days. Holds that are about to end show up here a week ahead.</p>
            : <ul>{soon.slice(0, 5).map((item) => <li key={item.id} className="border-t border-[var(--line)] py-1.5 first:border-t-0 first:pt-0">
              <a href={item.href} className={`block rounded hover:underline ${FOCUS}`}><span className="block text-[12px] font-medium">{item.title}</span><span className="block text-[11px] text-[var(--muted)]">{item.projectName}</span></a>
            </li>)}{soon.length > 5 && <li className="pt-1 text-[11px] text-[var(--muted)]">and {soon.length - 5} more</li>}</ul>}
        </section>
      </div>
    </div>

    {open && <InboxPopover key={open.id} anchor={rowElement} beside={cardElement} onClose={closePopover} keepOpen={inGridRow}
      title={`${open.name} · ${open.count} to do`} subtitle={[open.stage, open.client].filter(Boolean).join(" · ")}>
      {byKind(open.items).map((group) => <div key={group.kind} className="grid gap-2">
        <p className="flex items-start gap-2 rounded-[10px] bg-[#fff8f8] px-2.5 py-2 leading-relaxed text-slate-600"><span className="mt-[5px] flex"><Dot on /></span><span>{REASON[group.kind]}</span></p>
        <ul className="border-t border-[var(--line)]">{group.items.map((item) => <li key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-px border-b border-[var(--line)] py-2">
          <span className="min-w-0 text-[13px] font-semibold">{item.itemLabel}{fresh.has(item.id) && <NewMark />}</span>
          <span title={item.amount.part === "approved" ? PART_NOTE.approved : undefined} className={`text-right font-medium tabular-nums ${item.amount.part === "approved" ? "text-[var(--muted)]" : ""}`}>{usd(item.amount.cents)}</span>
          <span className="min-w-0 text-[11px] text-[var(--muted)]">{item.supplier ?? PART_NOTE[item.amount.part]}</span>
          <a href={item.href} aria-label={`Open ${item.itemLabel}`} className={`justify-self-end rounded text-[11px] font-medium text-[var(--primary)] hover:underline ${FOCUS}`}>Open ›</a>
        </li>)}</ul>
      </div>)}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <a href={open.paymentsHref} className={`inline-flex rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] ${FOCUS}`}>{ACTION[open.items[0].kind]}</a>
        <a href={open.chatHref} className={`rounded text-[12px] font-medium text-[var(--primary)] hover:underline ${FOCUS}`}>Open project chat</a>
      </div>
    </InboxPopover>}
  </InboxFrame>;
}
