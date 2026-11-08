import { describe, expect, it } from "vitest";
import { STUDIO_CASES } from "@/demo/studio-cases";
import { studioMoneyTotals } from "@/demo/studio-types";
import { exampleProjects } from "./examples";
import { deskTotals } from "./types";

const byId = Object.fromEntries(exampleProjects().map((project) => [project.id, project]));
const totals = (id: string) => deskTotals(byId[id]);

describe("prepared example projects on the money desk", () => {
  it("keeps every recorded example amount: each money line belongs to an item of the agreement", () => {
    for (const project of STUDIO_CASES) {
      const recorded = studioMoneyTotals(project), shown = deskTotals(byId[project.id]);
      expect({ held: shown.heldCents, charged: shown.chargedCents, refunded: shown.refundedCents, credit: shown.toRefundCents })
        .toEqual({ held: recorded.held, charged: recorded.captured, refunded: recorded.refunded, credit: recorded.awaitingCredit });
    }
  });

  it("shows a return waiting for its supplier credit as money to refund, and the agreement as fully covered", () => {
    expect(totals("fieldwork-goods")).toMatchObject({ chargedCents: 512_000, toRefundCents: 221_000, keptCents: 291_000, heldCents: 118_000, notFundedCents: 0, needsYou: 2 });
    expect(byId["fieldwork-goods"].agreedCents).toBe(409_000);
    expect(byId["fieldwork-goods"].items.find((item) => item.toRefundCents)).toMatchObject({ status: "Awaiting supplier credit", waitingOn: "designer" });
  });

  it("settles a completed return: charged less refunded equals the agreement", () => {
    expect(totals("harbor-flat")).toMatchObject({ keptCents: 408_400, refundedCents: 194_400, notFundedCents: 0, needsYou: 0 });
  });

  it("keeps the approved V1 as the agreement while a revision waits for the client", () => {
    expect(byId["alder-bistro"]).toMatchObject({ version: 1, agreedCents: 756_000, proposedCents: 879_600 });
    expect(totals("alder-bistro")).toMatchObject({ keptCents: 180_000, notFundedCents: 576_000, needsYou: 0 });
    expect(byId["northline-office"]).toMatchObject({ version: 1, agreedCents: 331_400, proposedCents: null });
    expect(totals("northline-office")).toMatchObject({ heldCents: 212_400, needsYou: 2 });
  });

  it("treats a quote that was never sent as proposed, with nothing requested yet", () => {
    expect(byId["stillwater-salon"]).toMatchObject({ version: null, agreedCents: null, proposedCents: 400_400 });
    expect(byId["stillwater-salon"].items.every((item) => item.status === "Not requested" && item.waitingOn === null)).toBe(true);
    expect(totals("stillwater-salon").notFundedCents).toBe(0);
  });
});
