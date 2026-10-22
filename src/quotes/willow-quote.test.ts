import { describe, expect, it } from "vitest";
import { mapleApprovedQuote } from "./demo-quote";
import { calculateLineTotals, calculateQuoteTotals } from "./totals";
import { willowApprovedQuote } from "./willow-quote";

describe("Willow supplier quote integrity", () => {
  const lines = willowApprovedQuote.lines;
  const products = lines.filter((line) => line.category === "furniture");
  const services = lines.filter((line) => line.category === "service");

  it("contains 22 distinct supplier products and 6 simulated services", () => {
    expect(lines).toHaveLength(28);
    expect(products).toHaveLength(22);
    expect(services).toHaveLength(6);
    expect(new Set(lines.map((line) => line.itemId)).size).toBe(28);
    expect(new Set(products.map((line) => line.sku)).size).toBe(22);
  });

  it("names four fictional suppliers and traces every product to one of their quotes", () => {
    expect([...new Set(products.map((line) => line.vendor))].sort()).toEqual([
      "Alder Row Furniture (demo)", "Larkspur Lighting (demo)", "Quillmark Office (demo)", "Saltmarsh Textiles (demo)",
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
      expect(line.nonReturnable).toBeNull();
      expect(line.leadTimeDays).toBeNull();
      expect(line.specification.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(willowApprovedQuote)).not.toMatch(/ikea/i);
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
    expect(productTotals).toMatchObject({ subtotalCents: 373_681, taxCents: 32_697, freightCents: 9_900, totalCents: 416_278 });
    expect(serviceTotals).toMatchObject({ subtotalCents: 453_000, taxCents: 0, freightCents: 0, totalCents: 453_000 });
    expect(allTotals).toMatchObject({ lineCount: 28, subtotalCents: 826_681, taxCents: 32_697, freightCents: 9_900, totalCents: 869_278 });
    expect(lines.filter((line) => line.freightCents !== 0)).toEqual([lines[0]]);
    // $799 × 8.75% is $69.9125: the first line rounds to $69.91.
    expect(lines[0].taxCents).toBe(6_991);
    const diningChairs = products.find((line) => line.itemId === "willow-dining-chair")!;
    expect(diningChairs.quantity).toBe(4);
    expect(calculateLineTotals(diningChairs)).toMatchObject({ subtotalCents: 32_000, taxCents: 2_800 });
    expect(willowApprovedQuote.assumptions.join(" ")).toContain("8.75%");
    expect(willowApprovedQuote.assumptions.join(" ")).toContain("not a supplier delivery quote");
  });

  it("counts bulb packs separately from bulbs, covers and cushion inserts", () => {
    const e26 = products.find((line) => line.itemId === "willow-bulbs-e26")!;
    const e12 = products.find((line) => line.itemId === "willow-bulbs-e12")!;
    expect([e26.unitLabel, e26.quantity, e26.unitPriceCents]).toEqual(["2-pack", 2, 499]);
    expect([e12.unitLabel, e12.quantity, e12.unitPriceCents]).toEqual(["2-pack", 1, 799]);
    expect(calculateLineTotals(e26).subtotalCents).toBe(998);
    expect(calculateLineTotals(e12).subtotalCents).toBe(799);
    expect(products.find((line) => line.itemId === "willow-cushion-cover")?.quantity).toBe(4);
    expect(products.find((line) => line.itemId === "willow-inner-cushion")?.quantity).toBe(4);
    expect(e12.specification).toContain("compatibility not yet verified");
  });

  it("labels clearance prices and keeps every approval explicitly simulated", () => {
    for (const itemId of ["willow-area-rug", "willow-cushion-cover"]) {
      expect(products.find((line) => line.itemId === itemId)?.source.priceNote).toContain("Clearance");
    }
    expect(willowApprovedQuote.isDemo).toBe(true);
    expect(willowApprovedQuote.signature).toContain("demo signature");
    expect(willowApprovedQuote.paymentNote).toContain("No PayPal authorization, charge or refund");
    for (const line of lines) {
      expect(line.approval.status).toBe("approved");
      expect(line.approval.isDemo).toBe(true);
      expect(line.approval.signature).toContain("demo signature");
    }
  });

  it("leaves the three-line Maple V1 example at its original $1,500", () => {
    expect(mapleApprovedQuote.lines).toHaveLength(3);
    expect(calculateQuoteTotals(mapleApprovedQuote.lines).totalCents).toBe(150_000);
  });
});
