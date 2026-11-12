/**
 * Where a document's pages break. The document is a list of measured blocks;
 * a page ends only between two of them, a block that must stay with the next
 * (a section heading) never ends a page, and a table row that opens a page, or
 * follows something other than its own table, brings the table's header.
 * Pure, so the sheets on screen, the printed pages and the tests agree.
 */
export interface MeasuredBlock {
  height: number;
  /** Space above the block when another block precedes it on the page. */
  gap: number;
  /** The table a row belongs to. */
  table?: string;
  /** Never the last block on a page. */
  keepWithNext?: boolean;
}

export interface Page {
  /** Indexes of the page's blocks, in order. */
  blocks: number[];
  /** The height they take, gaps and repeated table headers included; above the page height only when one block, or one heading with what it keeps, is taller than a page. */
  height: number;
}

export function paginate(blocks: readonly MeasuredBlock[], pageHeight: number, headHeights: Readonly<Record<string, number>> = {}): Page[] {
  /** What block `index` adds after block `previous` on the same page (null: it opens the page). */
  const cost = (index: number, previous: number | null) => {
    const block = blocks[index];
    const opensTable = block.table !== undefined && (previous === null || blocks[previous].table !== block.table);
    return (previous === null ? 0 : block.gap) + (opensTable ? headHeights[block.table!] ?? 0 : 0) + block.height;
  };
  const pages: Page[] = [];
  let page: Page = { blocks: [], height: 0 };
  for (let index = 0; index < blocks.length; index++) {
    const previous = page.blocks.at(-1) ?? null;
    // Inside a run of kept blocks the break was decided where the run began.
    if (previous !== null && !blocks[previous].keepWithNext) {
      let needed = cost(index, previous);
      for (let next = index; blocks[next].keepWithNext && next + 1 < blocks.length; next++) needed += cost(next + 1, next);
      if (page.height + needed > pageHeight) {
        pages.push(page);
        page = { blocks: [], height: 0 };
      }
    }
    page.height += cost(index, page.blocks.at(-1) ?? null);
    page.blocks.push(index);
  }
  if (page.blocks.length || !pages.length) pages.push(page);
  return pages;
}
