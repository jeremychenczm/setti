import { describe, expect, it } from "vitest";
import { exampleProjects } from "@/money-desk/examples";
import { exampleAttention } from "@/payments/attention-view";
import type { MoneyEvent } from "@/payments/money-events";
import { newBatches, projectRows, rowShown, tiles } from "./inbox-rows";

const projects = exampleProjects().map((project) => ({ id: project.id, name: project.name, source: project.source, stage: project.stage, client: project.client, paymentsHref: `/quotes/${project.id}?tab=payments`, chatHref: `/chats/${project.id}` }));
const view = { reminders: exampleAttention(), projects };

describe("the designer's inbox grid", () => {
  it("groups the to-dos into tiles and one row per project, and a tile narrows the rows to its kind", () => {
    expect(tiles(view.reminders).map((tile) => [tile.id, tile.count, tile.projects, tile.heldCents, tile.toRefundCents]))
      .toEqual([["confirm", 6, 3, 717_400, 0], ["credit", 1, 1, 0, 221_000], ["holds", 0, 0, 0, 0], ["paypal", 0, 0, 0, 0]]);

    const all = projectRows(view, { bucket: null, source: "all" }, new Set());
    expect(all.map((row) => [row.name, row.count, row.todo, row.heldCents, row.toRefundCents])).toEqual([
      ["Juniper Coffee", 3, "Confirm 3 orders, then charge", 387_000, 0],
      ["Fieldwork Goods", 2, "Record 1 credit, confirm 1 order", 118_000, 221_000],
      ["Northline Office", 2, "Confirm 2 orders, then charge", 212_400, 0],
    ]);
    expect(all[0].heldShare).toBe(1);

    const credit = projectRows(view, { bucket: "credit", source: "all" }, new Set()).filter((row) => rowShown(row, "all"));
    expect(credit.map((row) => [row.name, row.count, row.todo, row.toRefundCents])).toEqual([["Fieldwork Goods", 1, "Record 1 credit, then refund", 221_000]]);
    expect(projectRows(view, { bucket: null, source: "live" }, new Set()).filter((row) => rowShown(row, "live"))).toEqual([]);
  });
});

describe("the client's new records", () => {
  const event = (id: string, kind: MoneyEvent["kind"], itemLabel: string, amountCents: number, at: string, via: "webhook" | "readback" | null = "webhook"): MoneyEvent =>
    ({ id, kind, itemLabel, amountCents, at, paypalId: null, checked: via ? { at, via, status: null } : null });

  it("batches records of one step by kind and time, newest first, and says how PayPal confirmed them", () => {
    const batches = newBatches([
      event("h1", "held", "Oak window counter", 336_000, "2026-11-09T17:04:00Z"),
      event("h2", "held", "Acoustic ceiling panel", 174_000, "2026-11-09T17:04:10Z"),
      event("c1", "charged", "Quartz countertop", 396_000, "2026-11-09T17:05:00Z", "readback"),
      event("h3", "held", "Counter stool", 152_000, "2026-11-09T17:06:00Z", null),
      event("h4", "held", "Back bar wall tile", 117_000, "2026-11-09T18:30:00Z"),
    ]);
    expect(batches.map((batch) => [batch.totalCents, batch.names, batch.confirmation])).toEqual([
      [117_000, "Back bar wall tile", "Confirmed by PayPal at Nov 9, 10:30 AM."],
      [396_000, "Quartz countertop", "Checked with PayPal at Nov 9, 9:05 AM."],
      [662_000, "Oak window counter, Acoustic ceiling panel, Counter stool", "2 of 3 confirmed by PayPal."],
    ]);
    expect(batches[2].title).toBe("Nov 9, 9:06 AM · 3 holds placed");
  });
});
