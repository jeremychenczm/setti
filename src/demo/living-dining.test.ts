import { describe, expect, it } from "vitest";
import { calculateQuoteTotals } from "../quotes/totals";
import { HOME_APPROVED_QUOTE, HOME_DESIGNER_REQUEST, HOME_DISCUSSION, HOME_ITEM_IDS, HOME_SCENARIO, HOME_SCENARIO_VERSION, HOME_SUPPLIER_NOTES } from "./living-dining";

describe("Maple living-and-dining scenario", () => {
  it("keeps six approved baseline lines with stable furniture identities and per-chair pricing", () => {
    expect(HOME_SCENARIO).toBe("maple-living-dining-v3");
    expect(HOME_SCENARIO_VERSION).toBe(3);
    const quote = HOME_APPROVED_QUOTE;
    expect(quote.projectId).toBe("maple");
    expect(quote.version).toBe(1);
    expect(quote.lines.filter((line) => line.category === "furniture").map((line) => line.itemId)).toEqual(HOME_ITEM_IDS);
    expect(quote.lines).toHaveLength(6);
    expect(quote.lines.find((line) => line.itemId === "dining-chairs")).toMatchObject({ quantity: 6, unitPriceCents: 18_000 });
    expect(quote.lines.find((line) => line.itemId === "design")).toMatchObject({ category: "service", quantity: 1, unitPriceCents: 100_000 });
    expect(calculateQuoteTotals(quote.lines)).toMatchObject({ subtotalCents: 773_000, taxCents: 0, freightCents: 0, totalCents: 773_000 });
    expect(quote.lines.every((line) => line.approval.status === "approved" && line.taxCents === 0 && line.freightCents === 0)).toBe(true);
    expect(quote.assumptions.join(" ")).toMatch(/demo assumptions/);
  });

  it("gives every supplier line an independent fictional reference without invented external links", () => {
    const references = HOME_APPROVED_QUOTE.lines.map((line) => line.source.reference);
    expect(new Set(references).size).toBe(HOME_APPROVED_QUOTE.lines.length);
    for (const line of HOME_APPROVED_QUOTE.lines) {
      expect(line.source.kind).toBe("demo");
      expect(line.source.url).toBeUndefined();
      expect(HOME_SUPPLIER_NOTES).toContain(`[${line.source.reference}] itemId=${line.itemId}`);
      expect(HOME_SUPPLIER_NOTES).toContain(line.sku);
      expect(line.specification).not.toBe("");
      expect(line.returnPolicy).toMatch(/Fictional/);
    }
    expect(HOME_SUPPLIER_NOTES).toContain("not real supplier documents");
    expect(HOME_APPROVED_QUOTE.paymentNote).toContain("does not confirm");
  });

  it("keeps quantity, shape and retained-cost cross-checks consistent for the five changes", () => {
    expect(HOME_SUPPLIER_NOTES).toContain("unit USD 180, quantity 2, combined line USD 360");
    expect(HOME_SUPPLIER_NOTES).toContain("110 cm diameter × 75 cm high, suitable for four people");
    expect(HOME_SUPPLIER_NOTES).toContain("Revised quantity 4 × unit USD 180 = USD 720");
    const sideboard = HOME_APPROVED_QUOTE.lines.find((line) => line.itemId === "sideboard")!;
    const retainedCents = sideboard.quantity * sideboard.unitPriceCents * sideboard.restockingFeeBps! / 10_000;
    expect(retainedCents).toBe(24_000);
    expect(sideboard.unitPriceCents - retainedCents).toBe(96_000);
    const revisedGoodsCents = 210_000 + 2 * 18_000 + 125_000 + 4 * 18_000;
    const revisedTotalCents = revisedGoodsCents + 100_000 + retainedCents;
    expect(revisedTotalCents).toBe(567_000);
    expect(calculateQuoteTotals(HOME_APPROVED_QUOTE.lines).totalCents - revisedTotalCents).toBe(206_000);
    // The source documents provide unit prices and terms, not the consolidated answer.
    expect(HOME_SUPPLIER_NOTES).not.toMatch(/5,670|2,060|4,430/);
    expect(HOME_SUPPLIER_NOTES).toContain("supplier credit before refunding");
  });

  it("ends the human discussion on direction only and leaves the first AI draft explicit", () => {
    expect(HOME_DISCUSSION.length).toBeGreaterThanOrEqual(16);
    expect(HOME_DISCUSSION.length).toBeLessThanOrEqual(20);
    expect(new Set(HOME_DISCUSSION.map((message) => message.actor))).toEqual(new Set(["client", "designer"]));
    const discussion = HOME_DISCUSSION.map((message) => message.text).join(" ");
    expect(discussion).not.toMatch(/@AI|\$|USD|restocking fee is \d|writing desk|wool rug|lounge chair/i);
    expect(HOME_DISCUSSION.at(-1)).toMatchObject({ actor: "client" });
    expect(HOME_DISCUSSION.at(-1)!.text).toContain("check it before confirming");
    expect(HOME_DESIGNER_REQUEST.startsWith("@AI ")).toBe(true);
    expect(HOME_DESIGNER_REQUEST).toContain("our discussion");
    expect(HOME_DESIGNER_REQUEST.length).toBeLessThan(80);
    // The request must ask the model to read the evidence, not supply the calculated answer.
    expect(HOME_DESIGNER_REQUEST).not.toMatch(/\d|USD|\$|sofa|sideboard|dining-chairs|coffee-table|dining-table/i);
  });
});
