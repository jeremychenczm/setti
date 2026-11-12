import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@/payments/attention";
import type { MoneyEvent } from "@/payments/money-events";
import { newBatches, projectRows, rowShown, tiles } from "./inbox-rows";

const reminder = (itemLabel: string, kind: AttentionItem["kind"], heldCents: number): AttentionItem => ({
  id: `maple:proposed:${itemLabel}:${kind}`, kind, projectKey: "maple", projectName: "Maple Ave Café", itemId: itemLabel, side: "proposed", itemLabel,
  supplier: "Birch Line Joinery (demo)", amount: { cents: heldCents, part: "held" }, title: itemLabel, detail: "", urgency: kind === "capture_ready" ? "soon" : "now", href: "/change-orders/v2",
});
const projects = [{ id: "maple", name: "Maple Ave Café", stage: "V2 confirmed", client: "Emma Park", paymentsHref: "/change-orders/v2#payments", chatHref: "/chats/maple" }];
const view = { reminders: [reminder("Oak window counter", "not_ordered", 336_000), reminder("Counter stool", "not_ordered", 273_000), reminder("Counter pendant light", "capture_ready", 144_000)], projects };

describe("the designer's inbox grid", () => {
  it("groups the to-dos into tiles and one row per project, and a tile narrows the row to its kind", () => {
    expect(tiles(view.reminders).map((tile) => [tile.id, tile.count, tile.projects, tile.heldCents]))
      .toEqual([["confirm", 3, 1, 753_000], ["credit", 0, 0, 0], ["holds", 0, 0, 0], ["paypal", 0, 0, 0]]);

    const [row] = projectRows(view, { bucket: null }, new Set(["maple:proposed:Counter stool:not_ordered"]));
    expect([row.name, row.count, row.todo, row.heldCents, row.heldShare, row.isNew]).toEqual(["Maple Ave Café", 3, "Order 2 held items, charge 1 item", 753_000, 1, true]);
    expect(projectRows(view, { bucket: "holds" }, new Set()).filter(rowShown)).toEqual([]);
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
