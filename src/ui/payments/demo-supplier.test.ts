import { describe, expect, it } from "vitest";
import { demoSupplierNumber } from "./demo-supplier";

describe("demo supplier numbers", () => {
  it("names each item's demo order and credit note readably", () => {
    expect(demoSupplierNumber("order", "willow-desk")).toBe("DEMO-SO-WILLOW-DESK");
    expect(demoSupplierNumber("credit", "sideboard")).toBe("DEMO-CN-SIDEBOARD");
    expect(demoSupplierNumber("order", "coffee-table")).toBe("DEMO-SO-COFFEE-TABLE");
  });

  it("keeps only letters, digits and single hyphens, and stays short", () => {
    expect(demoSupplierNumber("order", "  maple-ld:compact sofa  ")).toBe("DEMO-SO-MAPLE-LD-COMPACT-SOFA");
    expect(demoSupplierNumber("order", "---")).toBe("DEMO-SO-ITEM");
    expect(demoSupplierNumber("order", "x".repeat(80))).toHaveLength("DEMO-SO-".length + 40);
  });
});
