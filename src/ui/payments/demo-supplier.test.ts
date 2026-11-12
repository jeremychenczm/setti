import { describe, expect, it } from "vitest";
import { demoSupplierNumber } from "./demo-supplier";

describe("demo supplier numbers", () => {
  it("gives two new lines with the same id prefix different numbers", () => {
    const counter = demoSupplierNumber("order", "new-8c4d39e8-14e8-441a-a431-5ecf14f2418f-change-5", "Oak window counter");
    const panel = demoSupplierNumber("order", "new-8c4d39e8-14e8-441a-a431-5ecf14f2418f-change-6", "Acoustic ceiling panel");
    expect(counter).toBe("DEMO-SO-OAK-WINDOW-COUNTER");
    expect(panel).not.toBe(counter);
    expect(demoSupplierNumber("order", "new-8c4d39e8-14e8-441a-a431-5ecf14f2418f-change-5")).not.toBe(demoSupplierNumber("order", "new-8c4d39e8-14e8-441a-a431-5ecf14f2418f-change-6"));
  });
});
