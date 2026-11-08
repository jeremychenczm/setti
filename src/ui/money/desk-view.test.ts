import { describe, expect, it } from "vitest";
import { exampleProjects } from "@/money-desk/examples";
import type { DeskProject, MoneyDesk } from "@/money-desk/types";
import { barScale, defaultSelection, filterCounts, itemBlocks, itemPart, needs, projectBar, summary, visibleProjects, waterfall } from "./desk-view";

const examples = exampleProjects();
const byId = (id: string) => examples.find((project) => project.id === id)!;
const live: DeskProject = {
  id: "maple", name: "Maple Ave", client: "Emma Park", source: "live", stage: "V1 approved", version: 1, agreedCents: 773_000, proposedCents: null, href: "/quotes/maple",
  items: [
    { id: "design", name: "Design services", category: "service", agreedCents: 100_000, heldCents: 0, chargedCents: 100_000, refundedCents: 0, toRefundCents: 0, status: "Payment completed", next: "", waitingOn: null },
    { id: "sofa", name: "Three-seat sofa", category: "furniture", agreedCents: 240_000, heldCents: 240_000, chargedCents: 0, refundedCents: 0, toRefundCents: 0, status: "Awaiting supplier confirmation", next: "", waitingOn: "designer" },
  ],
};
const desk: MoneyDesk = { checkedAt: "2026-11-07T12:00:00.000Z", projects: [live, ...examples] };

describe("the money desk's numbers", () => {
  it("adds every agreed project's waterfall up to exactly its agreement", () => {
    for (const project of examples.filter((entry) => entry.agreedCents !== null)) {
      const { steps, total, agreed } = waterfall(project);
      expect(agreed).toBe(true);
      expect(steps.at(-1)!.to).toBe(total);
      expect(total).toBe(project.agreedCents);
    }
  });

  it("splits a return waiting for its credit into charged, held and to-refund blocks on one scale", () => {
    const scale = barScale(examples);
    const { blocks, proposedShare } = projectBar(byId("fieldwork-goods"), scale);
    expect(proposedShare).toBeNull();
    expect(blocks.map((block) => [block.part, block.cents])).toEqual([["kept", 291_000], ["held", 118_000], ["toRefund", 221_000]]);
    expect(blocks.every((block) => block.share > 0 && block.share <= 1)).toBe(true);
  });

  it("draws a quote nobody agreed yet as an outline of its proposed total", () => {
    const scale = barScale(examples);
    expect(projectBar(byId("stillwater-salon"), scale)).toEqual({ blocks: [], proposedShare: 400_400 / scale });
    expect(waterfall(byId("stillwater-salon"))).toMatchObject({ agreed: false, total: 400_400 });
  });

  it("lists what needs the designer with the money each next step moves", () => {
    const fieldwork = needs([byId("fieldwork-goods")]);
    expect(fieldwork.map((row) => [row.item, row.amountCents, row.part, row.action])).toEqual([
      ["Returned display panels · retained cost", 221_000, "toRefund", "record the credit, then refund"],
      ["Freestanding modular shelves", 118_000, "held", "confirm, then charge"],
    ]);
    expect(needs(examples)).toHaveLength(7);
  });

  it("colours an item by the money that matters most for it", () => {
    const [design, sofa] = live.items;
    expect([itemPart(design), itemPart(sofa)]).toEqual(["kept", "held"]);
    expect(itemBlocks(sofa)).toEqual([{ part: "held", cents: 240_000, share: 1 }]);
  });

  it("filters live projects from examples and opens on a live project", () => {
    expect(filterCounts(desk)).toEqual({ all: 7, live: 1, example: 6 });
    expect(visibleProjects(desk, "live")).toEqual([live]);
    expect(defaultSelection(desk.projects)).toBe("maple");
    expect(summary([live])).toMatchObject({ heldCents: 240_000, chargedCents: 100_000, projectsWith: { held: 1, charged: 1, refunded: 0, toRefund: 0 } });
  });
});
