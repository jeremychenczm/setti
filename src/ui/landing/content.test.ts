import { describe, expect, it } from "vitest";
import { HOME_APPROVED_QUOTE, HOME_DISCUSSION } from "@/demo/living-dining";
import { DESIGN_FEE_CENTS, EMMA_MESSAGE, MAPLE_CHANGES, MAPLE_MONEY, V1_TOTAL_CENTS, V2_TOTAL_CENTS, usd } from "./content";

const line = (itemId: string) => HOME_APPROVED_QUOTE.lines.find((entry) => entry.itemId === itemId)!;
const moves = (itemId: string) => Object.fromEntries(MAPLE_MONEY.find((entry) => entry.itemId === itemId)!.moves.map((move) => [move.kind, move.cents]));

describe("landing page facts", () => {
  it("states Maple's V1 prices and total exactly as the demo quote has them", () => {
    for (const change of MAPLE_CHANGES) expect(change.beforeCents).toBe(line(change.itemId).unitPriceCents * line(change.itemId).quantity);
    expect(DESIGN_FEE_CENTS).toBe(line("design").unitPriceCents);
    expect(V1_TOTAL_CENTS).toBe(HOME_APPROVED_QUOTE.lines.reduce((sum, entry) => sum + entry.unitPriceCents * entry.quantity, 0));
  });

  it("states the V2 total the app's own walkthrough test reaches", () => {
    expect(V2_TOTAL_CENTS).toBe(567_000);
    expect([usd(V1_TOTAL_CENTS), usd(V2_TOTAL_CENTS)]).toEqual(["$7,730", "$5,670"]);
  });

  it("moves each item's money in a way that adds up to its V1 and V2 prices", () => {
    for (const itemId of ["sofa", "coffee-table", "dining-table"]) {
      const change = MAPLE_CHANGES.find((entry) => entry.itemId === itemId)!;
      expect(moves(itemId)).toEqual({ released: change.beforeCents, held: change.afterCents });
    }
    const chairs = MAPLE_CHANGES.find((entry) => entry.itemId === "dining-chairs")!;
    expect(moves("dining-chairs")).toEqual({ charged: chairs.afterCents, released: chairs.beforeCents - chairs.afterCents });
    const sideboard = MAPLE_CHANGES.find((entry) => entry.itemId === "sideboard")!;
    const feeBps = line("sideboard").restockingFeeBps ?? 0;
    expect(feeBps).toBe(2_000);
    const kept = sideboard.beforeCents * feeBps / 10_000;
    expect(moves("sideboard")).toEqual({ refunded: sideboard.beforeCents - kept, kept });
    expect(sideboard.afterCents).toBe(kept);
  });

  it("quotes a message the client really sent in the demo discussion", () => {
    expect(HOME_DISCUSSION.find((message) => message.text === EMMA_MESSAGE)?.actor).toBe("client");
  });
});
