import { describe, expect, it } from "vitest";
import { hashRevision, type LineSnapshot } from "./hash";

const line = (itemId: string, unitPriceCents: number): LineSnapshot => ({
  itemId,
  quantity: 1,
  unitPriceCents,
  taxCents: 0,
  freightCents: 0,
  restockingFeeBps: null,
  returnable: true,
  customMade: false,
  leadTimeDays: null,
});

describe("hashRevision", () => {
  it("does not depend on line order", () => {
    expect(hashRevision([line("a", 100), line("b", 200)])).toBe(hashRevision([line("b", 200), line("a", 100)]));
  });

  it("changes when a price changes", () => {
    expect(hashRevision([line("a", 100)])).not.toBe(hashRevision([line("a", 101)]));
  });

  it("changes when return terms change", () => {
    expect(hashRevision([line("a", 100)])).not.toBe(hashRevision([{ ...line("a", 100), restockingFeeBps: 2000 }]));
  });
});
