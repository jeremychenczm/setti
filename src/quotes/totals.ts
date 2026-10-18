import type { ApprovedQuoteLine } from "./types";

export type QuoteLineAmounts = Pick<
  ApprovedQuoteLine,
  "quantity" | "unitPriceCents" | "taxCents" | "freightCents"
>;

export interface QuoteLineTotals {
  subtotalCents: number;
  taxCents: number;
  freightCents: number;
  totalCents: number;
}

export interface QuoteTotals extends QuoteLineTotals {
  lineCount: number;
  itemCount: number;
}

function assertSafeCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer number of cents`);
  }
}

function safeSum(values: readonly number[], field: string): number {
  return values.reduce((sum, value) => {
    const result = sum + value;
    assertSafeCents(result, field);
    return result;
  }, 0);
}

/** Tax and freight are line-level amounts and are added once after quantity. */
export function calculateLineTotals(line: QuoteLineAmounts): QuoteLineTotals {
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
    throw new RangeError("quantity must be a positive safe integer");
  }
  assertSafeCents(line.unitPriceCents, "unitPriceCents");
  assertSafeCents(line.taxCents, "taxCents");
  assertSafeCents(line.freightCents, "freightCents");

  const subtotalCents = line.quantity * line.unitPriceCents;
  assertSafeCents(subtotalCents, "subtotalCents");

  return {
    subtotalCents,
    taxCents: line.taxCents,
    freightCents: line.freightCents,
    totalCents: safeSum([subtotalCents, line.taxCents, line.freightCents], "totalCents"),
  };
}

export function calculateQuoteTotals(lines: readonly QuoteLineAmounts[]): QuoteTotals {
  const amounts = lines.map(calculateLineTotals);
  const subtotalCents = safeSum(amounts.map((line) => line.subtotalCents), "subtotalCents");
  const taxCents = safeSum(amounts.map((line) => line.taxCents), "taxCents");
  const freightCents = safeSum(amounts.map((line) => line.freightCents), "freightCents");

  return {
    lineCount: lines.length,
    itemCount: safeSum(lines.map((line) => line.quantity), "itemCount"),
    subtotalCents,
    taxCents,
    freightCents,
    totalCents: safeSum([subtotalCents, taxCents, freightCents], "totalCents"),
  };
}
