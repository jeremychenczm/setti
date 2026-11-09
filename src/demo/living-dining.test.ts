import { describe, expect, it } from "vitest";
import { calculateQuoteTotals } from "../quotes/totals";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_EARLY_ITEMS, HOME_ITEM_IDS, HOME_SCENARIO, HOME_SCENARIO_VERSION, HOME_SERVICE_IDS, HOME_SUPPLIER_NOTES } from "./living-dining";

const line = (itemId: string) => HOME_APPROVED_QUOTE.lines.find((entry) => entry.itemId === itemId)!;

describe("Maple Ave Café scenario", () => {
  it("keeps six approved baseline lines: two services and four products priced per foot, box and piece", () => {
    expect(HOME_SCENARIO).toBe("maple-living-dining-v3");
    expect(HOME_SCENARIO_VERSION).toBe(4);
    const quote = HOME_APPROVED_QUOTE;
    expect(quote).toMatchObject({ projectId: "maple", projectName: "Maple Ave Café", version: 1 });
    expect(quote.lines.filter((entry) => entry.category === "furniture").map((entry) => entry.itemId)).toEqual(HOME_ITEM_IDS);
    expect(quote.lines.filter((entry) => entry.category === "service").map((entry) => entry.itemId)).toEqual(HOME_SERVICE_IDS);
    expect(HOME_EARLY_ITEMS.every((itemId) => (HOME_ITEM_IDS as readonly string[]).includes(itemId))).toBe(true);
    expect(line("countertop")).toMatchObject({ quantity: 22, unitLabel: "linear ft", unitPriceCents: 18_000, customMade: true, nonReturnable: true });
    expect(line("wall-tile")).toMatchObject({ quantity: 14, unitLabel: "box", unitPriceCents: 7_000, restockingFeeBps: 2_000 });
    expect(line("pendants")).toMatchObject({ quantity: 6, unitPriceCents: 24_000 });
    expect(line("stools")).toMatchObject({ quantity: 8, unitPriceCents: 19_500 });
    expect(line("design")).toMatchObject({ quantity: 1, unitPriceCents: 240_000 });
    expect(line("site-visits")).toMatchObject({ quantity: 4, unitLabel: "visit", unitPriceCents: 18_000 });
    expect(calculateQuoteTotals(quote.lines)).toMatchObject({ subtotalCents: 1_106_000, taxCents: 0, freightCents: 0, totalCents: 1_106_000 });
    expect(quote.lines.every((entry) => entry.approval.status === "approved" && entry.taxCents === 0 && entry.freightCents === 0)).toBe(true);
    expect(quote.assumptions.join(" ")).toMatch(/demo assumptions/);
  });

  it("gives every supplier line an independent fictional reference without invented external links", () => {
    const references = HOME_APPROVED_QUOTE.lines.map((entry) => entry.source.reference);
    expect(new Set(references).size).toBe(HOME_APPROVED_QUOTE.lines.length);
    for (const entry of HOME_APPROVED_QUOTE.lines) {
      expect(entry.source.kind).toBe("demo");
      expect(entry.source.url).toBeUndefined();
      expect(HOME_SUPPLIER_NOTES).toContain(`[${entry.source.reference}] `);
      expect(HOME_SUPPLIER_NOTES).toContain(entry.sku);
      expect(entry.specification).not.toBe("");
      expect(entry.returnPolicy).toMatch(/Fictional/);
    }
    expect(HOME_SUPPLIER_NOTES).toContain("not real suppliers");
    expect(HOME_APPROVED_QUOTE.paymentNote).toContain("does not confirm");
  });

  it("keeps the documents consistent with the seven changes without giving their answers", () => {
    // The documents give unit prices, coverage and terms; the quantities come from the discussion.
    expect(HOME_SUPPLIER_NOTES).toContain("re-cut to a shorter length for a fixed re-cut fee of USD 280 per top");
    expect(HOME_SUPPLIER_NOTES).toContain("the same 4 × 4 in tile in a sage green glaze; one box covers 10 sq ft; USD 76 per box");
    expect(HOME_SUPPLIER_NOTES).toContain("We keep 20% of the returned goods price");
    expect(HOME_SUPPLIER_NOTES).toContain("USD 210 per linear foot");
    expect(HOME_SUPPLIER_NOTES).toContain("charcoal; USD 145 each");
    expect(HOME_SUPPLIER_NOTES).toContain("USD 180 per visit");
    // 120 sq ft of back-bar wall and 60 of side wall, plus 10% for cuts, at 10 sq ft a box.
    const tileBoxes = Math.ceil((120 + 60) * 1.1 / 10);
    expect(tileBoxes).toBe(20);
    const removedFeet = 22 - (10 + 8);
    expect(removedFeet).toBe(4);
    const restockingCents = 14 * 7_000 * 0.2;
    const proposed = {
      design: 240_000, visits: 6 * 18_000, countertop: 18 * 18_000, recut: 28_000, tile: tileBoxes * 7_600, restocking: restockingCents,
      pendants: 4 * 24_000, stools: 14 * 19_500, windowCounter: 16 * 21_000, panels: 12 * 14_500,
    };
    const revisedTotalCents = Object.values(proposed).reduce((sum, cents) => sum + cents, 0);
    expect(revisedTotalCents).toBe(1_750_600);
    expect(revisedTotalCents - calculateQuoteTotals(HOME_APPROVED_QUOTE.lines).totalCents).toBe(644_600);
    // The refunds the change leads to: the removed countertop length less the re-cut fee, and the
    // returned white tile less its restocking fee.
    expect(removedFeet * 18_000 - 28_000).toBe(44_000);
    expect(14 * 7_000 - restockingCents).toBe(78_400);
    // The source documents provide prices and terms, not the answer: no totals, quantities to use,
    // refunds or instructions to the model.
    expect(HOME_SUPPLIER_NOTES).not.toMatch(/17,506|6,446|USD 440|USD 784|USD 196|USD 1,170|USD 3,360|USD 1,740|USD 1,520|20 boxes|18 linear|14 stools|12 panels/);
    expect(HOME_SUPPLIER_NOTES).not.toMatch(/\bDo not\b|\bdo not\b|itemId=|not_ordered|old-item|the designer must|consult the/i);
  });

  it("ends the human discussion on direction only and leaves the first AI draft explicit", () => {
    expect(HOME_DISCUSSION.length).toBeGreaterThanOrEqual(18);
    expect(HOME_DISCUSSION.length).toBeLessThanOrEqual(26);
    expect(new Set(HOME_DISCUSSION.map((message) => message.actor))).toEqual(new Set(["client", "designer"]));
    const discussion = HOME_DISCUSSION.map((message) => message.text).join(" ");
    expect(discussion).not.toMatch(/@Setti|\$|USD|restocking fee is \d|re-cut fee is \d/i);
    // The tile quantity is left to work out from the areas and the cutting allowance.
    expect(discussion).toMatch(/60 square feet/);
    expect(discussion).toMatch(/allow 10% for cuts/);
    expect(discussion).not.toMatch(/20 boxes|twenty boxes/i);
    expect(HOME_DISCUSSION.at(-1)).toMatchObject({ actor: "client" });
    expect(HOME_DISCUSSION.at(-1)!.text).toContain("check it before confirming");
    expect(HOME_DESIGNER_REQUEST.startsWith("@Setti ")).toBe(true);
    expect(HOME_DESIGNER_REQUEST).toContain("our discussion");
    expect(HOME_DESIGNER_REQUEST.length).toBeLessThan(80);
    // The request must ask the model to read the evidence, not supply the calculated answer.
    expect(HOME_DESIGNER_REQUEST).not.toMatch(/\d|USD|\$|countertop|tile|stool|pendant|panel/i);
  });
});
