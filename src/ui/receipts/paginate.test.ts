import { describe, expect, it } from "vitest";
import { paginate, type MeasuredBlock } from "./paginate";

describe("A4 pagination", () => {
  it("breaks only between blocks, keeps a heading with what follows and repeats the table header", () => {
    const blocks: MeasuredBlock[] = [
      { height: 300, gap: 0 },
      { height: 40, gap: 24, keepWithNext: true },
      { height: 100, gap: 12, table: "changes" },
      { height: 100, gap: 0, table: "changes" },
      { height: 100, gap: 0, table: "changes" },
      { height: 100, gap: 0, table: "changes" },
      { height: 30, gap: 24, keepWithNext: true },
      { height: 500, gap: 12 },
    ];
    const pages = paginate(blocks, 700, { changes: 30 });
    // The third row would overflow page 1; it opens page 2 with the header again. The heading would fit there, but not with its block.
    expect(pages).toEqual([{ blocks: [0, 1, 2, 3], height: 606 }, { blocks: [4, 5], height: 230 }, { blocks: [6, 7], height: 542 }]);
    expect(pages.flatMap((page) => page.blocks)).toEqual(blocks.map((_, index) => index));
  });

  it("gives a block taller than a page a page of its own instead of splitting it", () => {
    expect(paginate([{ height: 100, gap: 0 }, { height: 900, gap: 12 }, { height: 50, gap: 12 }], 700))
      .toEqual([{ blocks: [0], height: 100 }, { blocks: [1], height: 900 }, { blocks: [2], height: 50 }]);
  });
});
