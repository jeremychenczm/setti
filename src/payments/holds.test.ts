import { describe, expect, it } from "vitest";
import { summarizeHold } from "./holds";

describe("summarizeHold", () => {
  it("keeps the uncaptured part on hold while the hold is open", () => {
    expect(summarizeHold({ authorizedCents: 10_000, capturedCents: 4_000, closed: false })).toEqual({
      authorizedCents: 10_000,
      capturedCents: 4_000,
      heldCents: 6_000,
      releasedCents: 0,
    });
  });

  it("releases the uncaptured part once the hold is closed", () => {
    expect(summarizeHold({ authorizedCents: 10_000, capturedCents: 4_000, closed: true }).releasedCents).toBe(6_000);
  });

  it("never reports a negative amount after an over-capture", () => {
    expect(summarizeHold({ authorizedCents: 10_000, capturedCents: 11_500, closed: true })).toMatchObject({ heldCents: 0, releasedCents: 0 });
  });
});
