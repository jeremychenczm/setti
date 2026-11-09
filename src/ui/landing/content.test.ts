import { describe, expect, it } from "vitest";
import { HOME_APPROVED_QUOTE, HOME_DISCUSSION } from "@/demo/living-dining";
import { DESIGN_FEE_CENTS, EMMA_MESSAGE, MAPLE_CHANGES, MAPLE_MONEY, V1_TOTAL_CENTS, V2_TOTAL_CENTS, usd } from "./content";

const line = (itemId: string) => HOME_APPROVED_QUOTE.lines.find((entry) => entry.itemId === itemId)!;
const moves = (itemId: string) => Object.fromEntries(MAPLE_MONEY.find((entry) => entry.itemId === itemId)!.moves.map((move) => [move.kind, move.cents]));

describe("landing page facts", () => {
  it("states Maple's V1 prices and total exactly as the demo quote has them", () => {
    for (const change of MAPLE_CHANGES) {
      // The window counter and the panels are new in V2, so they have no V1 line and no V1 price.
      if (change.beforeCents === 0) { expect(HOME_APPROVED_QUOTE.lines.some((entry) => entry.itemId === change.itemId)).toBe(false); continue; }
      expect(change.beforeCents).toBe(line(change.itemId).unitPriceCents * line(change.itemId).quantity);
    }
    expect(DESIGN_FEE_CENTS).toBe(line("design").unitPriceCents);
    expect(V1_TOTAL_CENTS).toBe(HOME_APPROVED_QUOTE.lines.reduce((sum, entry) => sum + entry.unitPriceCents * entry.quantity, 0));
  });

  it("states the V2 total the app's own walkthrough test reaches", () => {
    expect(V2_TOTAL_CENTS).toBe(1_750_600);
    expect([usd(V1_TOTAL_CENTS), usd(V2_TOTAL_CENTS)]).toEqual(["$11,060", "$17,506"]);
  });

  it("moves each item's money in a way that adds up to its V1 and V2 prices", () => {
    const change = (itemId: string) => MAPLE_CHANGES.find((entry) => entry.itemId === itemId)!;
    // Added quantity and new pieces are held on top of what V1 already holds.
    expect(moves("stools")).toEqual({ held: change("stools").afterCents - change("stools").beforeCents });
    for (const itemId of ["window-counter", "panels"]) expect(moves(itemId)).toEqual({ held: change(itemId).afterCents });
    // A reduced held line is charged for what stays and releases the rest.
    expect(moves("pendants")).toEqual({ charged: change("pendants").afterCents, released: change("pendants").beforeCents - change("pendants").afterCents });
    // A paid line that shrinks or goes back keeps its new price plus the supplier's fee and refunds the rest.
    const recutFee = 28_000;
    expect(moves("countertop")).toEqual({ kept: change("countertop").afterCents, refunded: change("countertop").beforeCents - change("countertop").afterCents });
    expect(change("countertop").afterCents).toBe(18 * line("countertop").unitPriceCents + recutFee);
    const tile = line("wall-tile"), restocking = tile.quantity * tile.unitPriceCents * (tile.restockingFeeBps ?? 0) / 10_000;
    expect(moves("wall-tile")).toEqual({ refunded: change("wall-tile").beforeCents - restocking, kept: restocking, held: 20 * 7_600 });
    expect(change("wall-tile").afterCents).toBe(20 * 7_600 + restocking);
    // Extra site visits are paid as a services difference.
    expect(moves("site-visits")).toEqual({ charged: change("site-visits").afterCents - change("site-visits").beforeCents });
  });

  it("quotes a message the client really sent in the demo discussion", () => {
    expect(HOME_DISCUSSION.find((message) => message.text === EMMA_MESSAGE)?.actor).toBe("client");
  });
});
