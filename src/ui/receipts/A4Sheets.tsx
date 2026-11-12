"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { paginate, type Page } from "./paginate";

/** An A4 sheet is 210 × 297 mm; at 96 CSS px to the inch it is 793.7 px wide. */
const SHEET_WIDTH_PX = (210 / 25.4) * 96;
/** Room for rounding: measured heights are fractional and a table split in two can differ by a pixel. */
const SLACK_PX = 2;

const sheet = "flex w-[210mm] flex-col bg-white px-[60px] pb-[34px] pt-[56px] text-[13px] leading-relaxed text-[var(--ink)] [print-color-adjust:exact]";

/** A table that may run over several sheets: fixed columns, so each part lines up, and the header repeated on each. */
export interface SheetTable {
  /** CSS widths, "auto" for the column that takes the rest. */
  columns: string[];
  /** The header row's cells. */
  head: ReactNode;
}

interface Kept {
  key: string;
  /** Space above the block when another block precedes it on the sheet. */
  gap?: number;
  /** Never the last block on a sheet, as a section heading. */
  keepWithNext?: boolean;
}
type Row = Kept & { table: string; cells: ReactNode; className?: string };
/** One unbreakable part of a document: a block of its own, or one row of a table. */
export type SheetBlock = (Kept & { node: ReactNode; table?: undefined }) | Row;

const isRow = (block: SheetBlock): block is Row => block.table !== undefined;

/** The blocks at `indexes`, in order, with each run of one table's rows in a table of its own. */
function Blocks({ blocks, indexes: given, tables }: { blocks: readonly SheetBlock[]; indexes: readonly number[]; tables: Readonly<Record<string, SheetTable>> }) {
  // A layout made for a longer document is shown for one render after blocks are removed, until it is measured again.
  const indexes = given.filter((index) => index < blocks.length);
  const parts: ReactNode[] = [];
  for (let at = 0; at < indexes.length;) {
    const first = blocks[indexes[at]];
    const style = at ? { marginTop: first.gap ?? 0 } : undefined;
    if (!isRow(first)) {
      parts.push(<div key={first.key} data-block={indexes[at]} className="flow-root" style={style}>{first.node}</div>);
      at++;
      continue;
    }
    let end = at;
    while (end < indexes.length && blocks[indexes[end]].table === first.table) end++;
    const table = tables[first.table];
    parts.push(<table key={first.key} data-table={first.table} className="w-full table-fixed border-collapse text-[12px]" style={style}>
      <colgroup>{table.columns.map((width, index) => <col key={index} style={width === "auto" ? undefined : { width }} />)}</colgroup>
      <thead><tr>{table.head}</tr></thead>
      <tbody>{indexes.slice(at, end).map((index) => {
        const row = blocks[index] as Row;
        return <tr key={row.key} data-block={index} className={row.className}>{row.cells}</tr>;
      })}</tbody>
    </table>);
    at = end;
  }
  return parts;
}

/**
 * A document as real A4 sheets. Every block is measured once at the sheet's
 * width, then packed into pages between blocks (see paginate). On screen the
 * sheets shrink to fit their container; printed, each sheet is one A4 page at
 * full size with its own footer, so the page numbers on screen and on paper
 * are the same.
 */
export function A4Sheets({ blocks, tables, footer, label }: {
  blocks: readonly SheetBlock[];
  tables: Readonly<Record<string, SheetTable>>;
  footer: (page: number, pages: number) => ReactNode;
  /** Names the document for assistive technology. */
  label: string;
}) {
  const measure = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ pages: Page[]; room: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [fonts, setFonts] = useState(0);

  // Web fonts change line breaks, so the blocks are measured again once they load.
  useEffect(() => {
    const faces = document.fonts;
    if (!faces) return;
    let live = true;
    const remeasure = () => { if (live) setFonts((count) => count + 1); };
    void faces.ready.then(remeasure);
    faces.addEventListener("loadingdone", remeasure);
    return () => { live = false; faces.removeEventListener("loadingdone", remeasure); };
  }, []);

  useLayoutEffect(() => {
    const copy = measure.current, body = probe.current;
    if (!copy || !body) return;
    const heights = new Map<number, number>();
    copy.querySelectorAll<HTMLElement>("[data-block]").forEach((element) => heights.set(Number(element.dataset.block), element.getBoundingClientRect().height));
    const heads: Record<string, number> = {};
    copy.querySelectorAll<HTMLTableElement>("table[data-table]").forEach((table) => { heads[table.dataset.table!] ??= table.tHead?.getBoundingClientRect().height ?? 0; });
    const room = body.getBoundingClientRect().height - SLACK_PX;
    const pages = paginate(blocks.map((block, index) => ({ height: heights.get(index) ?? 0, gap: block.gap ?? 0, table: block.table, keepWithNext: block.keepWithNext })), room, heads);
    setLayout((current) => current && current.room === room && JSON.stringify(current.pages) === JSON.stringify(pages) ? current : { pages, room });
  }, [blocks, tables, fonts]);

  // The sheets scale with the space they are given, never above full size.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => setScale(Math.min(1, element.clientWidth / SHEET_WIDTH_PX));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const all = blocks.map((_, index) => index);
  return <div className="relative w-full" role="region" aria-label={label}>
    {/* The measuring copy: one empty sheet for the room a page has, and every block at the sheet's width. Never seen or printed. */}
    <div aria-hidden inert className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden print:hidden">
      <div className={`${sheet} h-[297mm]`}><div ref={probe} className="min-h-0 flex-1" />{footer(1, 1)}</div>
      <div ref={measure} className={sheet}><Blocks blocks={blocks} indexes={all} tables={tables} /></div>
    </div>
    <div ref={frame} className="grid w-full justify-items-center gap-4 print:block">
      {layout?.pages.map((page, index) => {
        // Only a block taller than a page makes its sheet longer than A4.
        const over = Math.max(0, Math.ceil(page.height - layout.room));
        const size = { "--sheet-scale": scale, "--sheet-height": over ? `calc(297mm + ${over}px)` : "297mm" } as CSSProperties;
        return <div key={index} style={size} className="relative h-[calc(var(--sheet-height)*var(--sheet-scale))] w-[calc(210mm*var(--sheet-scale))] print:h-auto print:w-auto print:break-after-page print:last:break-after-auto">
          <div className={`${sheet} absolute left-0 top-0 h-[var(--sheet-height)] origin-top-left shadow-[0_1px_2px_rgba(29,33,27,.12),0_10px_30px_rgba(29,33,27,.14)] [scale:var(--sheet-scale)] print:static print:shadow-none print:[scale:1] ${over ? "print:h-auto print:min-h-[297mm]" : "print:h-[296.5mm] print:overflow-hidden"}`}>
            <div className="min-h-0 flex-1"><Blocks blocks={blocks} indexes={page.blocks} tables={tables} /></div>
            {footer(index + 1, layout.pages.length)}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
