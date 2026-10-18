import { describe, expect, it } from "vitest";
import { addBusinessDays, refundPromise } from "./refundPromise";

describe("addBusinessDays", () => {
  it("skips the weekend", () => {
    // Friday 2026-10-16 + 5 business days = Friday 2026-10-23
    expect(addBusinessDays(new Date("2026-10-16T15:00:00Z"), 5).toISOString()).toBe("2026-10-23T00:00:00.000Z");
    // Wednesday 2026-10-14 + 5 business days = Wednesday 2026-10-21
    expect(addBusinessDays(new Date("2026-10-14T09:00:00Z"), 5).toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });

  it("starting on a Saturday counts from Monday", () => {
    expect(addBusinessDays(new Date("2026-10-17T10:00:00Z"), 1).toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("rejects negative or fractional day counts", () => {
    expect(() => addBusinessDays(new Date(), -1)).toThrow(RangeError);
    expect(() => addBusinessDays(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe("refundPromise", () => {
  it("refunds the captured amount minus the restocking fee, 5 business days after the vendor credit by default", () => {
    expect(
      refundPromise({
        capturedCents: 30_000,
        restockingFeeCents: 6_000,
        vendorCreditReceivedAt: new Date("2026-10-16T15:00:00Z"),
      }),
    ).toEqual({
      refundCents: 24_000,
      retainedCents: 6_000,
      dueDate: new Date("2026-10-23T00:00:00.000Z"),
    });
  });

  it("honours a custom window", () => {
    const p = refundPromise({
      capturedCents: 10_000,
      restockingFeeCents: 0,
      vendorCreditReceivedAt: new Date("2026-10-16T15:00:00Z"),
      businessDays: 2,
    });
    expect(p.dueDate.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(p.refundCents).toBe(10_000);
  });

  it("rejects a fee larger than the capture", () => {
    expect(() =>
      refundPromise({ capturedCents: 100, restockingFeeCents: 101, vendorCreditReceivedAt: new Date() }),
    ).toThrow(RangeError);
  });
});
