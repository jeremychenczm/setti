import { describe, expect, it } from "vitest";
import { isCaseKey } from "@/chat/cases";
import { STUDIO_CASES, studioCase } from "./studio-cases";
import { studioLineState, studioLineTotal, studioMoneyTotals, studioQuoteTotal } from "./studio-types";

describe("prepared designer project collection", () => {
  it("covers six businesses and stages without using live project identities", () => {
    expect(STUDIO_CASES).toHaveLength(6);
    expect(new Set(STUDIO_CASES.map((project) => project.id)).size).toBe(6);
    expect(new Set(STUDIO_CASES.map((project) => project.industry)).size).toBe(6);
    expect(new Set(STUDIO_CASES.map((project) => project.stage)).size).toBe(6);
    for (const project of STUDIO_CASES) {
      expect(isCaseKey(project.id)).toBe(false);
      expect(project.messages.length).toBeGreaterThanOrEqual(12);
      expect(new Set(project.messages.map((message) => message.at.slice(0, 10))).size).toBeGreaterThan(1);
      project.messages.forEach((message, index) => {
        expect(message.actor).toBe(index % 2 === 0 ? "client" : "designer");
        expect(message.text.trim().length).toBeGreaterThan(20);
        if (index) expect(Date.parse(message.at)).toBeGreaterThan(Date.parse(project.messages[index - 1].at));
      });
    }
    expect(studioCase("not-a-project")).toBeUndefined();
  });

  it("binds every payment line to its current quote and keeps money in valid cents", () => {
    for (const project of STUDIO_CASES) {
      expect(project.money.map((entry) => entry.lineId).sort()).toEqual(project.quote.lines.map((entry) => entry.id).sort());
      for (const document of [project.quote, ...(project.proposal ? [project.proposal] : [])]) {
        for (const entry of document.lines) {
          expect(Number.isSafeInteger(entry.quantity) && entry.quantity > 0).toBe(true);
          expect(Number.isSafeInteger(entry.unitPriceCents) && entry.unitPriceCents >= 0).toBe(true);
          expect(Number.isSafeInteger(studioLineTotal(entry))).toBe(true);
        }
      }
      for (const entry of project.money) {
        for (const amount of [entry.heldCents, entry.capturedCents, entry.refundedCents, entry.releasedCents, entry.awaitingCreditCents]) expect(Number.isSafeInteger(amount) && amount >= 0).toBe(true);
        expect(entry.refundedCents + entry.awaitingCreditCents).toBeLessThanOrEqual(entry.capturedCents);
      }
    }
  });

  it("shows a pending retail return as credit awaited, never a completed refund", () => {
    const project = studioCase("fieldwork-goods")!;
    expect(studioQuoteTotal(project.quote)).toBe(409_000);
    expect(studioMoneyTotals(project)).toMatchObject({ captured: 512_000, held: 118_000, refunded: 0, awaitingCredit: 221_000 });
    expect(studioLineState(project, project.money.find((entry) => entry.lineId === "retail-return")!)).toBe("Awaiting supplier credit");
  });

  it("balances the settled apartment, including the retained return cost", () => {
    const project = studioCase("harbor-flat")!;
    expect(studioMoneyTotals(project)).toMatchObject({ captured: 602_800, refunded: 194_400, held: 0, awaitingCredit: 0, netPaid: 408_400 });
    expect(studioMoneyTotals(project).netPaid).toBe(studioQuoteTotal(project.quote));
    const signed = project.messages.find((message) => message.text.startsWith("I've checked and signed"))!;
    const confirmed = project.messages.find((message) => message.text.startsWith("The supplier has now confirmed"))!;
    expect(confirmed.at.slice(0, 10) > signed.at.slice(0, 10)).toBe(true);
  });

  it("preserves V1 when a revision awaits approval or was declined", () => {
    const bistro = studioCase("alder-bistro")!, office = studioCase("northline-office")!;
    expect(bistro.quote).toMatchObject({ version: 1, status: "approved" });
    expect(bistro.proposal).toMatchObject({ version: 2, status: "awaiting_client" });
    expect(studioQuoteTotal(bistro.quote)).toBe(756_000);
    expect(studioQuoteTotal(bistro.proposal!)).toBe(879_600);
    expect(studioMoneyTotals(bistro)).toMatchObject({ captured: 180_000, held: 0 });
    expect(office.quote).toMatchObject({ version: 1, status: "approved" });
    expect(office.proposal).toMatchObject({ version: 2, status: "declined" });
    expect(studioQuoteTotal(office.quote)).toBe(331_400);
    expect(studioQuoteTotal(office.proposal!)).toBe(376_600);
    expect(office.money.some((entry) => entry.lineId === "office-film")).toBe(false);
  });

  it("has no funds before the salon quote is sent and keeps café goods held", () => {
    expect(studioMoneyTotals(studioCase("stillwater-salon")!)).toMatchObject({ held: 0, captured: 0, refunded: 0 });
    const coffee = studioCase("juniper-coffee")!;
    expect(studioQuoteTotal(coffee.quote)).toBe(549_000);
    expect(studioMoneyTotals(coffee)).toMatchObject({ held: 387_000, captured: 162_000, refunded: 0 });
  });
});
