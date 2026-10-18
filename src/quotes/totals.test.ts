import { describe, expect, it } from "vitest";
import { mapleApprovedQuote } from "./demo-quote";
import { calculateLineTotals, calculateQuoteTotals, type QuoteLineAmounts } from "./totals";

describe("approved quote totals", () => {
  const line: QuoteLineAmounts = {
    quantity: 3,
    unitPriceCents: 1_001,
    taxCents: 263,
    freightCents: 500,
  };

  it("keeps Maple V1 at $1,500 with the demo tax and freight assumptions", () => {
    expect(calculateQuoteTotals(mapleApprovedQuote.lines)).toEqual({
      lineCount: 3,
      itemCount: 3,
      subtotalCents: 150_000,
      taxCents: 0,
      freightCents: 0,
      totalCents: 150_000,
    });
  });

  it("multiplies unit price by quantity and adds line tax and freight once", () => {
    expect(calculateLineTotals(line)).toEqual({
      subtotalCents: 3_003,
      taxCents: 263,
      freightCents: 500,
      totalCents: 3_766,
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(() => calculateLineTotals({ ...line, quantity })).toThrow(RangeError);
    },
  );

  it.each(["unitPriceCents", "taxCents", "freightCents"] as const)(
    "rejects fractional or negative %s",
    (field) => {
      expect(() => calculateLineTotals({ ...line, [field]: 0.5 })).toThrow(RangeError);
      expect(() => calculateLineTotals({ ...line, [field]: -1 })).toThrow(RangeError);
    },
  );

  it("rejects overflow in a multiplied line or the full quote", () => {
    const largeLine = { quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER, taxCents: 0, freightCents: 0 };
    expect(() => calculateLineTotals({ ...largeLine, quantity: 2 })).toThrow(RangeError);
    expect(() => calculateQuoteTotals([largeLine, { ...largeLine, unitPriceCents: 1 }])).toThrow(RangeError);
  });
});
