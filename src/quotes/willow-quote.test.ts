import { describe, expect, it } from "vitest";
import { mapleApprovedQuote } from "./demo-quote";
import { calculateLineTotals, calculateQuoteTotals } from "./totals";
import { willowQuote } from "./willow-quote";

describe("Willow supplier quote integrity", () => {
  const lines = willowQuote.lines;
  const products = lines.filter((line) => line.category === "furniture");
  const services = lines.filter((line) => line.category === "service");

  it("contains 20 distinct supplier products and 6 simulated services", () => {
    expect(lines).toHaveLength(26);
    expect(products).toHaveLength(20);
    expect(services).toHaveLength(6);
    expect(new Set(lines.map((line) => line.itemId)).size).toBe(26);
    expect(new Set(products.map((line) => line.sku)).size).toBe(20);
  });

  it("names seven fictional suppliers and traces every product to one of their quotes", () => {
    expect([...new Set(products.map((line) => line.vendor))].sort()).toEqual([
      "Alder Row Furniture (demo)", "Fieldstone Floor & Tile (demo)", "Harbor Paint Co (demo)", "Larkspur Lighting (demo)",
      "Pinecrest Millwork (demo)", "Quillmark Office (demo)", "Saltmarsh Textiles (demo)",
    ]);
    for (const line of products) {
      expect(line.source.kind).toBe("demo");
      expect(line.source.url).toBeUndefined();
      expect(line.source.reference).toMatch(/^[A-Z]{3}-Q-\d{4} · /);
      expect(line.source.reference).toContain(line.sku);
      expect(line.source.note).toContain("Fictional supplier quote");
      expect(line.source.checkedAt).toBe("2026-10-17");
      expect(line.source.priceNote?.length).toBeGreaterThan(0);
      expect(line.returnPolicy).toContain("Demo supplier terms");
      expect(line.restockingFeeBps).toBeNull();
      expect(line.specification.length).toBeGreaterThan(0);
    }
    const madeToOrder = products.filter((line) => line.nonReturnable !== null);
    expect(madeToOrder.map((line) => [line.itemId, line.customMade, line.nonReturnable])).toEqual([
      ["willow-wall-paint", true, true], ["willow-office-shelving", true, true],
    ]);
    expect(products.filter((line) => line.leadTimeDays !== null).map((line) => [line.itemId, line.leadTimeDays])).toEqual([["willow-office-shelving", 35]]);
    expect(JSON.stringify(willowQuote)).not.toMatch(/ikea/i);
  });

  it("uses hourly estimates for services without implying that a supplier quoted them", () => {
    expect(services.map((line) => [line.quantity, line.unitPriceCents])).toEqual([
      [2, 15_000], [8, 15_000], [10, 12_500], [6, 10_000], [8, 8_500], [4, 12_500],
    ]);
    for (const line of services) {
      expect(line.unitLabel).toBe("hour");
      expect(line.vendor).toContain("simulated estimate");
      expect(line.source.kind).toBe("estimate");
      expect(line.source.note).toContain("not a supplier quote");
      expect(line.taxCents).toBe(0);
      expect(line.freightCents).toBe(0);
      expect(line.restockingFeeBps).toBeNull();
      expect(line.nonReturnable).toBeNull();
    }
  });

  it("preserves the full budget, including separately stated tax and one delivery allowance", () => {
    const productTotals = calculateQuoteTotals(products);
    const serviceTotals = calculateQuoteTotals(services);
    const allTotals = calculateQuoteTotals(lines);
    expect(productTotals).toMatchObject({ subtotalCents: 969_737, taxCents: 84_852, freightCents: 9_900, totalCents: 1_064_489 });
    expect(serviceTotals).toMatchObject({ subtotalCents: 453_000, taxCents: 0, freightCents: 0, totalCents: 453_000 });
    expect(allTotals).toMatchObject({ lineCount: 26, subtotalCents: 1_422_737, taxCents: 84_852, freightCents: 9_900, totalCents: 1_517_489 });
    expect(lines.filter((line) => line.freightCents !== 0)).toEqual([lines[0]]);
    // $799 × 8.75% is $69.9125: the first line rounds to $69.91.
    expect(lines[0].taxCents).toBe(6_991);
    const diningChairs = products.find((line) => line.itemId === "willow-dining-chair")!;
    expect(diningChairs.quantity).toBe(4);
    expect(calculateLineTotals(diningChairs)).toMatchObject({ subtotalCents: 32_000, taxCents: 2_800 });
    expect(willowQuote.assumptions.join(" ")).toContain("8.75%");
    expect(willowQuote.assumptions.join(" ")).toContain("not a supplier delivery quote");
  });

  it("quotes finish materials in the units they are sold in, supply only", () => {
    const finish = (itemId: string) => products.find((line) => line.itemId === itemId)!;
    expect(["willow-oak-flooring", "willow-entry-tile", "willow-wall-paint", "willow-downlights", "willow-office-shelving"]
      .map((itemId) => [finish(itemId).unitLabel, finish(itemId).quantity, finish(itemId).unitPriceCents]))
      .toEqual([["box", 20, 9_996], ["box", 4, 4_635], ["gallon", 9, 6_899], ["each", 6, 3_299], ["each", 1, 320_000]]);
    expect(calculateLineTotals(finish("willow-oak-flooring")).subtotalCents).toBe(199_920);
    expect(finish("willow-oak-flooring").specification).toContain("10% for cuts");
    expect(finish("willow-entry-tile").specification).toContain("installation by the client's contractor");
    expect(finish("willow-downlights").specification).toContain("licensed electrician");
    expect(willowQuote.assumptions.join(" ")).toContain("Finish materials are supply only");
  });

  it("labels clearance prices and carries no approval: the client's signature approves V1", () => {
    expect(products.filter((line) => line.source.priceNote?.includes("Clearance")).map((line) => line.itemId)).toEqual(["willow-area-rug"]);
    expect(willowQuote.isDemo).toBe(true);
    expect(willowQuote.paymentNote).toContain("No PayPal authorization, charge or refund");
    for (const field of ["status", "approvedAt", "approvedBy", "signature"]) expect(willowQuote).not.toHaveProperty(field);
    for (const line of lines) expect(line).not.toHaveProperty("approval");
  });

  it("leaves the three-line Maple V1 example at its original $1,500", () => {
    expect(mapleApprovedQuote.lines).toHaveLength(3);
    expect(calculateQuoteTotals(mapleApprovedQuote.lines).totalCents).toBe(150_000);
  });
});
