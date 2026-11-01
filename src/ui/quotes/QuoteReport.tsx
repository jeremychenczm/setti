"use client";

import { AllCommunityModule, themeQuartz, type ColDef, type GridApi, type ICellRendererParams, type RowSelectionOptions } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Armchair, ArrowLeft, ArrowUpRight, Check, ChevronRight, Clock, Download, FileText, LockKeyhole, Palette, PencilLine, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { clientSignatureName, type OpeningLine, type OpeningQuote, type OpeningStatus, type QuoteView, type SignOpeningInput } from "@/opening/types";
import { calculateLineTotals, calculateQuoteTotals, type QuoteLineTotals } from "@/quotes/totals";
import type { QuoteLine } from "@/quotes/types";
import { usd } from "../demo-data";
import { ProjectPayments } from "../payments/ProjectPayments";
import { LineReview, LineStateBadge, type LineChoice } from "./LineReview";
import { ResolvePanel, type ResolveItem } from "./ResolvePanel";
import { BulkDecisionBar } from "./BulkDecisionBar";
import { SignBar } from "./SignBar";

type QuoteRow = QuoteLine & QuoteLineTotals;
type CategoryFilter = "all" | "furniture" | "service";

const modules = [AllCommunityModule];
const quoteTheme = themeQuartz.withParams({
  accentColor: "#b27a26",
  backgroundColor: "#ffffff",
  foregroundColor: "#30362d",
  borderColor: "#e7e5db",
  headerBackgroundColor: "#f7f6f2",
  headerTextColor: "#7b7f73",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 11,
  rowHoverColor: "#fafaf8",
  // Ticked lines keep a plain background; the checkbox already shows the tick.
  selectedRowBackgroundColor: "#ffffff",
  wrapperBorder: false,
});

function ItemCell({ data }: ICellRendererParams<QuoteRow>) {
  if (!data) return null;
  const Icon = data.category === "service" ? Palette : Armchair;
  return (
    <div className="flex h-full items-center gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${data.category === "service" ? "bg-brand-50 text-brand-500" : "bg-stone-100 text-stone-500"}`}>
        <Icon className="h-5 w-5" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 leading-relaxed">
        <div className="truncate font-medium">{data.name}</div>
        <div className="truncate text-[11px] text-[var(--muted)]">{data.vendor.replace(" (demo)", "")} · {data.room}</div>
      </div>
    </div>
  );
}

const LINE_LABELS = { approved: "Approved", declined: "Declined", withdrawn: "Dropped", pending: "Awaiting client" } as const;

/** The whole V1 in a few words: draft, awaiting, partly or fully approved. */
function progressLabel(opening: OpeningQuote): string {
  const { approved, pending } = opening.progress;
  if (opening.status === "draft") return "Draft";
  if (approved === opening.lineCount) return "Approved";
  if (approved) return `Partially approved · ${approved} of ${opening.lineCount}`;
  return pending ? "Awaiting client" : "Declined";
}

function StatusBadge({ status, label }: { status: OpeningStatus; label?: string }) {
  if (status === "approved") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium leading-none text-emerald-700"><Check className="h-3 w-3" />{label ?? "Approved"}</span>;
  if (status === "sent") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium leading-none text-amber-800"><Clock className="h-3 w-3" />{label ?? "Awaiting client"}</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium leading-none text-slate-600"><PencilLine className="h-3 w-3" />{label ?? "Draft"}</span>;
}

/** What the page can ask the server to do; each returns an error to show, or null. */
export interface QuoteActions {
  sign: (input: SignOpeningInput) => Promise<string | null>;
  drop: (itemId: string) => Promise<string | null>;
  /** Puts a declined line in a designer draft and opens the pricing page. */
  revise: (itemId: string) => Promise<string | null>;
  /** Puts an approved line in a designer draft, to change its price, quantity or terms, and opens the pricing page. */
  changeLine: (itemId: string) => Promise<string | null>;
  ask: (itemId: string, text: string) => Promise<string | null>;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(value));
}

const QUOTE_LABELS: Record<CaseKey, string> = { willow: "Willow Residence · 28-line test quote", maple: "Maple Ave · 3-line payment example" };

/**
 * One project's V1 as the signed-in account may see it: a designer's draft, a
 * sent version, or an approved one. On an open V1 the client decides line by
 * line and signs; the designer resolves the lines that are not agreed.
 */
export function QuoteReport({ view, viewer, options, focusItemId, actions, onBack, onSelectQuote, onOpenChat }: {
  view: QuoteView; viewer: DemoAccount; options: CaseKey[]; focusItemId?: string | null; actions: QuoteActions;
  onBack: () => void; onSelectQuote: (id: CaseKey) => void; onOpenChat: () => void;
}) {
  const { document: quote, opening, approval, lines: lineStates } = view;
  const status = opening.status;
  const signedV1 = !approval && !!opening.sentAt;
  const open = signedV1 && !opening.closed;
  const reviewing = viewer.role === "client" && open && opening.progress.pending > 0;
  const lineOf = useCallback((itemId: string): OpeningLine => lineStates[itemId] ?? { state: approval ? "approved" : "pending", note: null, decidedAt: null, by: null, questions: 0 }, [lineStates, approval]);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  // One id per signature, kept across retries, so a lost response never records the decisions twice.
  const [signingId, setSigningId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Lines ticked in the table, for setting several choices at once. */
  const [ticked, setTicked] = useState<string[]>([]);
  const clientName = clientSignatureName(quote);
  const totals = useMemo(() => calculateQuoteTotals(quote.lines), [quote]);
  const allRows = useMemo<QuoteRow[]>(() => quote.lines.map((line) => ({ ...line, ...calculateLineTotals(line) })), [quote]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [room, setRoom] = useState("all");
  const [visibleCount, setVisibleCount] = useState(allRows.length);
  const [selectedId, setSelectedId] = useState<string | null>(focusItemId ?? null);
  // The item whose drawer opened from "Drop…" or "Withdraw…", which opens on that confirmation.
  const [dropFor, setDropFor] = useState<string | null>(null);
  const grid = useRef<GridApi<QuoteRow> | null>(null);
  const [gridReady, setGridReady] = useState(false);
  const selected = allRows.find((line) => line.itemId === selectedId);
  const rooms = useMemo(() => [...new Set(quote.lines.map((line) => line.room))], [quote]);
  const productSubtotal = useMemo(() => calculateQuoteTotals(quote.lines.filter((line) => line.category === "furniture")).subtotalCents, [quote]);
  const serviceSubtotal = totals.subtotalCents - productSubtotal;
  const supplierLines = quote.lines.filter((line) => line.category === "furniture" && line.source.kind === "demo");
  const supplierCount = new Set(supplierLines.map((line) => line.vendor)).size;
  const estimateCount = quote.lines.filter((line) => line.source.kind === "estimate").length;
  const approvedDate = approval ? dateLabel(approval.approvedAt) : null;
  const sentDate = opening.sentAt ? dateLabel(opening.sentAt) : null;
  const totalLabel = approval ? "Approved quote total" : "Quote total";
  const resolveItems: ResolveItem[] = viewer.role === "designer" && open
    ? quote.lines.filter((line) => ["declined", "pending"].includes(lineOf(line.itemId).state)).map((line) => ({ itemId: line.itemId, name: line.name, line: lineOf(line.itemId) }))
    : [];
  const pendingLines = quote.lines.filter((line) => lineOf(line.itemId).state === "pending");
  const chosen = pendingLines.filter((line) => choices[line.itemId]);
  const toApprove = chosen.filter((line) => choices[line.itemId].decision === "approved");
  const missingReasons = chosen.filter((line) => choices[line.itemId].decision === "declined" && !choices[line.itemId].note.trim()).map((line) => line.name);

  function choose(itemId: string, choice: LineChoice | null) {
    setNotice(null);
    setChoices((previous) => {
      const next = { ...previous };
      if (choice) next[itemId] = choice; else delete next[itemId];
      return next;
    });
  }

  function setTickedChoices(choice: LineChoice | null) {
    setNotice(null);
    setChoices((previous) => {
      const next = { ...previous };
      for (const itemId of ticked) {
        if (choice) next[itemId] = choice; else delete next[itemId];
      }
      return next;
    });
    grid.current?.deselectAll();
  }

  async function sign(signature: string) {
    const decisions = chosen.map((line) => {
      const choice = choices[line.itemId];
      return choice.decision === "declined" ? { itemId: line.itemId, decision: choice.decision, note: choice.note.trim() } : { itemId: line.itemId, decision: choice.decision };
    });
    const failure = await actions.sign({ signingId, contentHash: opening.contentHash!, signature, acknowledged: true, decisions });
    if (!failure) {
      setChoices({});
      grid.current?.deselectAll();
      setSigningId(crypto.randomUUID());
      setNotice("Signed. The studio sees your decisions in the project chat.");
    }
    return failure;
  }

  async function revise(itemId: string) {
    setActionError(null);
    const failure = await actions.revise(itemId);
    if (failure) setActionError(failure);
    return failure;
  }

  const columnDefs = useMemo<ColDef<QuoteRow>[]>(() => [
    { field: "name", headerName: "Item / supplier", pinned: "left", minWidth: 240, flex: 2, cellRenderer: ItemCell, getQuickFilterText: ({ data }) => data ? `${data.name} ${data.vendor} ${data.sku} ${data.specification} ${data.returnPolicy} ${data.source.name}` : "" },
    { field: "quantity", headerName: "Quantity", width: 105, minWidth: 100, type: "numericColumn", valueFormatter: ({ data, value }) => `${value ?? 0} ${data?.unitLabel ?? "each"}` },
    { field: "unitPriceCents", headerName: "Unit price", width: 110, minWidth: 100, type: "numericColumn", valueFormatter: ({ value }) => usd(value ?? 0) },
    { field: "taxCents", headerName: "Tax", width: 85, minWidth: 75, type: "numericColumn", valueFormatter: ({ value }) => usd(value ?? 0) },
    { field: "freightCents", headerName: "Delivery", width: 95, minWidth: 85, type: "numericColumn", valueFormatter: ({ value }) => usd(value ?? 0) },
    { field: "totalCents", headerName: "Line total", width: 115, minWidth: 105, type: "numericColumn", valueFormatter: ({ value }) => usd(value ?? 0), cellStyle: { fontWeight: 600 } },
    { colId: "approval", headerName: "Status", width: 175, minWidth: 160, valueGetter: ({ data }) => data ? status === "draft" ? "Draft" : LINE_LABELS[lineOf(data.itemId).state] : "", cellRenderer: ({ data }: ICellRendererParams<QuoteRow>) => data && <LineStateBadge state={lineOf(data.itemId).state} choice={choices[data.itemId]} draft={status === "draft"} forClient={viewer.role === "client"} /> },
    { colId: "details", headerName: "", width: 95, minWidth: 90, sortable: false, cellRenderer: ({ data }: ICellRendererParams<QuoteRow>) => data && <button aria-label={`View details for ${data.name}`} onClick={() => setSelectedId(data.itemId)} className="inline-flex items-center gap-0.5 text-[12px] font-medium text-[var(--primary)] hover:underline">Details<ChevronRight className="h-3.5 w-3.5" /></button> },
    { field: "vendor", headerName: "Supplier", hide: true },
    { field: "category", hide: true, filter: "agTextColumnFilter" },
    { field: "room", headerName: "Room / scope", hide: true, filter: "agTextColumnFilter" },
    { field: "unitLabel", headerName: "Unit", hide: true, valueGetter: ({ data }) => data?.unitLabel ?? "each" },
    { field: "sku", headerName: "Item reference", hide: true },
    { field: "specification", headerName: "Specification", hide: true },
    { field: "returnPolicy", headerName: "Return / cancellation terms", hide: true },
    { field: "source.name", headerName: "Price source", hide: true },
    { field: "source.url", headerName: "Source URL", hide: true },
    { field: "source.kind", headerName: "Source type", hide: true },
    { field: "source.checkedAt", headerName: "Price checked", hide: true },
    { field: "source.priceNote", headerName: "Price note", hide: true },
  ], [status, lineOf, choices, viewer.role]);
  const defaultColDef = useMemo<ColDef<QuoteRow>>(() => ({ sortable: true, resizable: true, editable: false, suppressMovable: true }), []);
  // While the client reviews, undecided lines can be ticked and set together; the header box ticks the undecided lines on the page shown.
  const rowSelection = useMemo<RowSelectionOptions<QuoteRow> | undefined>(() => reviewing ? {
    mode: "multiRow", checkboxes: true, headerCheckbox: true, selectAll: "currentPage", enableClickSelection: false, hideDisabledCheckboxes: true,
    isRowSelectable: (node) => !!node.data && lineOf(node.data.itemId).state === "pending",
  } : undefined, [reviewing, lineOf]);
  // For the demo, every undecided line starts ticked when the review opens, so approving them all is one click.
  const preTicked = useRef(false);
  useEffect(() => {
    if (!reviewing) { preTicked.current = false; return; }
    if (!gridReady || preTicked.current) return;
    preTicked.current = true;
    grid.current?.selectAll("all");
  }, [reviewing, gridReady]);
  const selectionColumn = useMemo<ColDef<QuoteRow>>(() => ({ pinned: "left", width: 48, minWidth: 48, maxWidth: 48, resizable: false, suppressHeaderMenuButton: true }), []);

  function downloadCsv() {
    grid.current?.exportDataAsCsv({
      fileName: `Setti-${quote.projectName.replace(/[^a-zA-Z0-9]+/g, "-")}-Quote-V${quote.version}-DEMO.csv`,
      exportedRows: "all",
      columnKeys: ["name", "vendor", "room", "sku", "specification", "quantity", "unitLabel", "unitPriceCents", "taxCents", "freightCents", "totalCents", "approval", "returnPolicy", "source.name", "source.kind", "source.url", "source.checkedAt", "source.priceNote"],
      processCellCallback: (params) => params.column.getColId() === "quantity" ? String(params.value) : params.formatValue(params.value) ?? String(params.value ?? ""),
      prependContent: [
        [{ data: { value: `Setti | ${quote.projectName} | Quote V${quote.version} | DEMO` } }],
        [{ data: { value: approval ? "Sample approval. This quote does not confirm payment." : status === "draft" ? "Draft, not sent to the client." : `Sent ${sentDate} · ${progressLabel(opening)}. This quote does not confirm payment.` } }],
        [{ data: { value: `Full quote total: ${usd(totals.totalCents)} USD` } }],
        ...quote.assumptions.map((assumption) => [{ data: { value: assumption } }]),
      ],
    });
  }

  function applyFilters(nextCategory: CategoryFilter, nextRoom: string) {
    setCategory(nextCategory);
    setRoom(nextRoom);
    grid.current?.setFilterModel({
      ...(nextCategory !== "all" ? { category: { filterType: "text", type: "equals", filter: nextCategory } } : {}),
      ...(nextRoom !== "all" ? { room: { filterType: "text", type: "equals", filter: nextRoom } } : {}),
    });
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-6 py-3.5">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" />Back to chats</button>
        <span className="text-[var(--line)]">/</span>
        {options.length > 1 ? <select aria-label="Select quote example" value={quote.projectId} onChange={(event) => onSelectQuote(event.target.value as CaseKey)} className="max-w-full rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[12px] font-medium">
          {options.map((key) => <option key={key} value={key}>{QUOTE_LABELS[key]}</option>)}
        </select> : <span className="text-[12px] font-medium">{quote.projectName}</span>}
        <span className="ml-auto rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">Demo quote</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1360px] px-5 py-7 lg:px-9">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted)]"><FileText className="h-3.5 w-3.5" />{quote.projectName} / Quote 001</div>
              <div className="flex items-center gap-3"><h1 className="text-[28px] font-semibold tracking-tight">{approval ? "Approved quote" : "Quote"}</h1><span className="rounded-md bg-[var(--canvas)] px-2 py-1 text-[12px] font-medium">V{quote.version}</span>{!approval && <StatusBadge status={status} label={progressLabel(opening)} />}</div>
              <p className="mt-1.5 text-[13px] text-[var(--muted)]">{quote.room} · {approval ? "Agreed scope and itemized prices." : "Proposed scope and itemized prices."}</p>
            </div>
            <div className="text-right"><div className="text-[11px] text-[var(--muted)]">{totalLabel} · USD</div><div className="mt-1 text-[32px] font-semibold tracking-tight tabular-nums">{usd(totals.totalCents)}</div><div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-[var(--muted)]">{status === "draft" ? <><PencilLine className="h-3 w-3" />Not sent yet</> : <><LockKeyhole className="h-3 w-3" />V{quote.version} is read-only</>}</div>{signedV1 && opening.progress.approved > 0 && <div className="mt-1 text-[12px] font-medium text-emerald-700">Approved {usd(opening.progress.approvedTotalCents)}{opening.progress.pending ? ` · ${opening.progress.pending} undecided` : ""}</div>}</div>
          </div>

          <div className="my-6 grid grid-cols-2 gap-5 border-y border-[var(--line)] py-5 xl:grid-cols-4">
            <Meta label="Project" value={quote.projectName} note={quote.room} />
            <Meta label="Prepared for" value={quote.clientName} note="Client" />
            <Meta label="Prepared by" value={quote.designerName} note="Lee Studio" />
            {approval ? <Meta label="Sample approval" value={approvedDate ?? ""} note={`By ${approval.approvedBy}`} /> : opening.signedAt ? <Meta label="Signed" value={dateLabel(opening.signedAt)} note={`By ${clientName}`} /> : sentDate ? <Meta label="Sent" value={sentDate} note={`By ${opening.sentBy ?? quote.designerName}`} /> : <Meta label="Status" value="Draft" note="Not sent to the client" />}
          </div>

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><h2 className="text-[14px] font-semibold">Quote details</h2><span className="rounded-full bg-[var(--canvas)] px-2 py-0.5 text-[11px] text-[var(--muted)]">{totals.lineCount} items</span></div>
            <button onClick={downloadCsv} title="Download all items in the quote, including filtered items" className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-2 text-[12px] font-medium hover:bg-[var(--canvas)]"><Download className="h-3.5 w-3.5" />Download CSV</button>
          </div>
          {supplierCount > 1 && <p className="mb-3 rounded-lg bg-brand-50 px-3 py-2.5 text-[11px] leading-relaxed text-brand-800">{supplierLines.length} items from {supplierCount} fictional supplier quotes + {estimateCount} simulated service estimates. Tax and delivery are test assumptions; select Details for the supplier quote, price note and return terms of each line.</p>}
          {resolveItems.length > 0 && <ResolvePanel items={resolveItems} onSelect={(itemId) => { setDropFor(null); setSelectedId(itemId); }} onDrop={(itemId) => { setDropFor(itemId); setSelectedId(itemId); }} onOpenChat={onOpenChat} onRevise={(item) => void revise(item.itemId)} />}
          {actionError && <p role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 text-[12px] text-red-800">{actionError}</p>}
          {reviewing && <p className="mb-3 rounded-lg border border-brand-100 bg-white px-3 py-2.5 text-[12px] leading-relaxed text-slate-600"><strong className="font-medium text-[var(--ink)]">Review each line.</strong> Select a line to approve or decline it, or to ask about it. Tick several lines to approve or decline them together. Lines you leave undecided can be signed later.</p>}
          {notice && <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-[12px] text-emerald-800">{notice}</p>}
          <div className="overflow-hidden rounded-xl border border-[var(--line)]">
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-4 py-3">
              <div className="flex gap-1 rounded-lg bg-[var(--canvas)] p-0.5" role="group" aria-label="Filter quote category">
                {([{ id: "all", label: "All items" }, { id: "furniture", label: "Products" }, { id: "service", label: "Services" }] as const).map((option) => <button key={option.id} aria-pressed={category === option.id} onClick={() => applyFilters(option.id, room)} className={`rounded-md px-3 py-1.5 text-[11px] ${category === option.id ? "bg-white font-medium shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}>{option.label}</button>)}
              </div>
              <select aria-label="Filter quote room" value={room} onChange={(event) => applyFilters(category, event.target.value)} className="rounded-lg border border-[var(--line)] bg-white px-2 py-1.5 text-[11px]">
                <option value="all">All rooms / scope</option>
                {rooms.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <label className="ml-auto flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5"><Search className="h-3.5 w-3.5 text-[var(--muted)]" /><input aria-label="Search quote items" placeholder="Find an item or supplier…" value={query} onChange={(event) => setQuery(event.target.value)} className="w-44 bg-transparent text-[12px] outline-none placeholder:text-[var(--muted)]" />{query && <button onClick={() => setQuery("")} aria-label="Clear quote search"><X className="h-3 w-3" /></button>}</label>
            </div>
            {reviewing && ticked.length > 0 && <BulkDecisionBar count={ticked.length} onApprove={() => setTickedChoices({ decision: "approved", note: "" })} onDecline={(reason) => setTickedChoices({ decision: "declined", note: reason })} onUndecide={() => setTickedChoices(null)} onClear={() => grid.current?.deselectAll()} />}
            <div className={`setti-quote-grid w-full ${allRows.length > 10 ? "h-[490px]" : "h-[310px]"}`}>
              <AgGridReact<QuoteRow>
                modules={modules}
                theme={quoteTheme}
                rowData={allRows}
                columnDefs={columnDefs}
                defaultColDef={defaultColDef}
                rowSelection={rowSelection}
                selectionColumnDef={selectionColumn}
                onSelectionChanged={({ api }) => setTicked(api.getSelectedRows().map((row) => row.itemId))}
                getRowId={({ data }) => data.itemId}
                quickFilterText={query}
                rowHeight={70}
                headerHeight={42}
                animateRows={false}
                enableCellTextSelection
                ensureDomOrder
                pagination={allRows.length > 10}
                paginationPageSize={10}
                paginationPageSizeSelector={false}
                suppressCellFocus={false}
                onGridReady={({ api }) => { grid.current = api; setGridReady(true); }}
                onModelUpdated={({ api }) => setVisibleCount(api.getDisplayedRowCount())}
                onRowClicked={({ data }) => { if (data) setSelectedId(data.itemId); }}
                overlayNoRowsTemplate="<span>No matching items. Clear your search or select another category.</span>"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] bg-slate-50/60 px-4 py-3 text-[11px] text-[var(--muted)]"><span aria-live="polite">Showing {visibleCount} of {totals.lineCount} items · Filters do not change the quote total</span><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[var(--primary-fill)]" />AG Grid Community</span></div>
          </div>

          {selected && <LineDetails key={`${selected.itemId}${dropFor === selected.itemId ? ":drop" : ""}`} line={selected} onClose={() => setSelectedId(null)}>
            {signedV1 && <LineReview
              name={selected.name} line={lineOf(selected.itemId)} role={viewer.role}
              canDecide={reviewing && lineOf(selected.itemId).state === "pending"}
              canResolve={resolveItems.some((item) => item.itemId === selected.itemId)}
              choice={choices[selected.itemId]} onChoose={(choice) => choose(selected.itemId, choice)}
              onAsk={(text) => actions.ask(selected.itemId, text)} onOpenChat={onOpenChat}
              startDropping={dropFor === selected.itemId} onDrop={() => actions.drop(selected.itemId)} onRevise={() => revise(selected.itemId)}
            />}
            {viewer.role === "designer" && open && lineOf(selected.itemId).state === "approved" && <ChangeLineButton onChange={async () => {
              setActionError(null);
              const failure = await actions.changeLine(selected.itemId);
              if (failure) setActionError(failure);
            }} />}
          </LineDetails>}

          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_300px]">
            {approval ? <div className="rounded-xl border border-[var(--line)] p-5">
              <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Check className="h-4 w-4" /></span><div><h2 className="text-[13px] font-semibold">Approved by {approval.approvedBy}</h2><p className="text-[11px] text-[var(--muted)]">{approvedDate} · Sample approval</p></div></div>
              <div className="mt-4 border-t border-[var(--line)] pt-3"><div className="font-serif text-xl italic text-slate-600">{approval.approvedBy}</div><p className="mt-1 text-[10px] text-[var(--muted)]">Demo typed signature · not an actual client signature</p></div>
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--muted)]">This approved version is read-only. Any change to items, prices or terms belongs in a new version.</p>
            </div> : <div className="rounded-xl border border-[var(--line)] p-5">
              <div className="flex items-center gap-2">{status === "approved" ? <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Check className="h-4 w-4" /></span> : status === "sent" ? <span className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-50 text-amber-700"><Clock className="h-4 w-4" /></span> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600"><PencilLine className="h-4 w-4" /></span>}<div><h2 className="text-[13px] font-semibold">{opening.signedAt ? `Signed by ${clientName}` : status === "sent" ? `Awaiting review by ${clientName}` : "Draft · only the studio can see it"}</h2><p className="text-[11px] text-[var(--muted)]">{opening.signedAt ? `${opening.progress.approved} approved · ${opening.progress.declined} declined · ${opening.progress.withdrawn} dropped · ${opening.progress.pending} undecided` : status === "sent" ? `Sent ${sentDate} by ${opening.sentBy ?? quote.designerName}` : "Prepared from the supplier quotes"}</p></div></div>
              <p className="mt-4 border-t border-[var(--line)] pt-3 text-[12px] leading-relaxed text-[var(--muted)]">{opening.closed ? "A newer version replaced V1. Its approved lines carried over as the baseline of that version." : opening.signedAt ? "The approved lines are the agreement, signed against this locked version. Declined lines can only return in a new version. Nothing has been charged." : status === "sent" ? "This version was locked when it was sent: the client reviews exactly these lines and prices, and any change needs a new version. No one has approved it yet, and nothing has been charged." : "Send it from the project chat. Sending locks this version for the client's review."}</p>
              {opening.contentHash && <details className="mt-3 text-[11px] text-[var(--muted)]"><summary className="cursor-pointer select-none font-medium hover:text-[var(--ink)]">Verification code</summary><p className="mt-1.5 leading-relaxed">Setti recorded this fingerprint of the sent version. If any line, price or term were changed later, it would no longer match.</p><p className="mt-1 break-all font-mono text-[10px]">SHA-256 {opening.contentHash}</p></details>}
            </div>}
            <div className="space-y-2.5 rounded-xl bg-[var(--canvas)] p-5 text-[12px]">
              <Amount label="Products" value={productSubtotal} />
              <Amount label="Design services" value={serviceSubtotal} />
              <Amount label="Tax" value={totals.taxCents} />
              <Amount label="Delivery" value={totals.freightCents} />
              <div className="border-t border-slate-200 pt-3"><Amount label={totalLabel} value={totals.totalCents} strong /></div>
              <p className="pt-1 text-[10px] leading-relaxed text-[var(--muted)]">Includes the tax and delivery assumptions listed below.{approval ? " Approval is simulated." : ""}</p>
            </div>
          </div>

          {open && opening.progress.approved > 0 && <ProjectPayments projectKey={quote.projectId as CaseKey} orderId={null} onServicesPaid={viewer.role === "client" ? onOpenChat : undefined} />}

          <div className="mt-6 rounded-xl border border-dashed border-slate-200 px-4 py-3 text-[11px] leading-relaxed text-[var(--muted)]"><span className="font-medium text-slate-600">About this example. </span>{quote.demoNotice}<ul className="mt-2 list-disc space-y-1 pl-4">{quote.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul><p className="mt-2 font-medium">{quote.paymentNote}</p></div>
        </div>
      </div>
      {reviewing && <SignBar clientName={clientName} version={quote.version} approveCount={toApprove.length} approveCents={calculateQuoteTotals(toApprove).totalCents} declineCount={chosen.length - toApprove.length} undecided={pendingLines.length - chosen.length} missingReasons={missingReasons}
        onSign={sign} />}
    </section>
  );
}

/** The designer starts a new version from an approved line, for example after a supplier's price notice. */
export function ChangeLineButton({ onChange }: { onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-3">
    <button type="button" disabled={busy} onClick={() => { setBusy(true); void onChange().finally(() => setBusy(false)); }} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)] disabled:opacity-50">Change this line</button>
    <span className="text-[11px] text-[var(--muted)]">Price, quantity or terms changed, for example a supplier&apos;s price notice? The client confirms it in a new version before any money moves.</span>
  </div>;
}

function Meta({ label, value, note }: { label: string; value: string; note: string }) {
  return <div><div className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">{label}</div><div className="mt-1.5 text-[13px] font-medium">{value}</div><div className="mt-0.5 text-[11px] text-[var(--muted)]">{note}</div></div>;
}

function Amount({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return <div className={`flex items-center justify-between gap-4 ${strong ? "text-[14px] font-semibold" : "text-slate-500"}`}><span>{label}</span><span className="tabular-nums">{usd(value)}</span></div>;
}

/** One quote line's card in a drawer beside the table: what it is, its terms and source, and its decision. */
function LineDetails({ line, onClose, children }: { line: QuoteRow; onClose: () => void; children?: ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (<>
    {/* A click beside the drawer closes it. */}
    <div aria-hidden className="fixed inset-0 z-30" onClick={onClose} />
    <aside id="quote-line-details" role="dialog" aria-labelledby="quote-line-title" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-[var(--line)] bg-white shadow-2xl">
      <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="quote-line-title" className="text-[15px] font-semibold leading-snug">{line.name}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">{line.vendor} · {line.room}</p>
          <p className="mt-2 text-[12px] tabular-nums text-slate-600">{line.quantity} × {usd(line.unitPriceCents)} · <span className="font-semibold text-[var(--ink)]">{usd(line.totalCents)}</span></p>
        </div>
        <button onClick={onClose} aria-label="Close item details" className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4 text-[12px]">
      <div className="space-y-5">
        <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Specification</div><p className="leading-relaxed">{line.specification}</p><p className="mt-2 text-[11px] text-[var(--muted)]">{line.sku} · {line.room} · Priced per {line.unitLabel ?? "each"}</p><p className="mt-1 text-[11px] text-[var(--muted)]">{line.leadTimeDays === null ? line.category === "service" ? "Service · no product delivery" : "Stock and lead time to be confirmed" : `Estimated lead time: ${line.leadTimeDays / 7} weeks (sample)`}</p></div>
        <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Return & cancellation terms</div><p className="leading-relaxed">{line.returnPolicy}</p><p className="mt-2 text-[11px] text-[var(--muted)]">{line.customMade ? "Custom-made" : "Not custom-made"} · {line.nonReturnable === null ? "Return eligibility to be confirmed" : line.nonReturnable ? "Non-returnable" : "See the agreed terms"}</p>{line.source.returnPolicyUrl && <a href={line.source.returnPolicyUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--primary)] hover:underline">Supplier return policy<ArrowUpRight className="h-3 w-3" /></a>}</div>
        <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Source · {line.source.kind === "public_reference" ? "public retail price" : line.source.kind === "estimate" ? "test estimate" : line.category === "furniture" ? "supplier quote" : "example"}</div><div className="flex items-start gap-1.5"><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--primary)]" /><span>{line.source.name}</span></div><p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">{line.source.note}</p>{line.source.priceNote && <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{line.source.priceNote}</p>}{line.source.checkedAt && <p className="mt-1 text-[10px] text-[var(--muted)]">Price checked: {line.source.checkedAt}</p>}<p className="mt-1 break-all font-mono text-[10px] text-[var(--muted)]">{line.source.reference}</p>{line.source.url && <a href={line.source.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--primary)] hover:underline">View product & price<ArrowUpRight className="h-3 w-3" /></a>}</div>
      </div>
      {children}
      </div>
    </aside>
  </>);
}
