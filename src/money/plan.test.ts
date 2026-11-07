import { describe, expect, it } from "vitest";
import { planChange } from "./plan";
import type { ExistingLine } from "./types";

const $ = (dollars: number) => Math.round(dollars * 100);

describe("worked example: swap the window chair for a desk and return the rug", () => {
  const lines: ExistingLine[] = [
    {
      id: "design",
      label: "Design services",
      category: "service",
      priceCents: $(400),
      payment: { kind: "captured", capturedCents: $(400), poPlaced: false },
    },
    {
      id: "chair",
      label: "Accent chair",
      category: "furniture",
      priceCents: $(800),
      payment: { kind: "held", authorizedCents: $(800) },
    },
    {
      id: "rug",
      label: "Rug",
      category: "furniture",
      priceCents: $(300),
      payment: { kind: "captured", capturedCents: $(300), poPlaced: true },
    },
  ];

  const plan = planChange(
    lines,
    [
      { type: "remove", lineId: "chair" },
      { type: "remove", lineId: "rug", restockingFeeBps: 2000 },
      { type: "add", lineId: "desk", label: "Light oak desk", category: "furniture", priceCents: $(1100) },
      { type: "add", lineId: "redesign", label: "Layout redesign", category: "service", priceCents: $(150) },
    ],
    { hasVault: true },
  );

  it("raises the budget by $210 (1,500 -> 1,710)", () => {
    expect(plan.budgetBeforeCents).toBe($(1500));
    expect(plan.budgetAfterCents).toBe($(1710));
    expect(plan.budgetDeltaCents).toBe($(210));
  });

  it("voids the $800 chair hold instead of refunding it", () => {
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "void_authorization", lineId: "chair", releaseCents: $(800) }),
    );
    expect(plan.actions.some((a) => a.kind === "refund" && a.lineId === "chair")).toBe(false);
  });

  it("returns the rug and promises $240 back after the vendor credit, keeping the $60 fee", () => {
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "vendor_return", lineId: "rug", restockingFeeCents: $(60) }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "refund",
        lineId: "rug",
        amountCents: $(240),
        retainedCents: $(60),
        timing: "after_vendor_credit",
        promiseBusinessDays: 5,
      }),
    );
  });

  it("holds $1,100 for the desk and charges the $150 redesign on approval", () => {
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "new_authorization", lineId: "desk", amountCents: $(1100), via: "vault" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "immediate_capture", lineId: "redesign", amountCents: $(150) }),
    );
  });

  it("keeps budget and money moves apart: +$210 budget, but $1,250 of new money", () => {
    expect(plan.money).toEqual({
      releasedCents: $(800),
      refundCents: $(240),
      newHoldCents: $(1100),
      newChargeCents: $(150),
    });
    expect(plan.money.newHoldCents + plan.money.newChargeCents).toBe($(1250));
    expect(plan.money.newHoldCents + plan.money.newChargeCents).not.toBe(plan.budgetDeltaCents);
  });
});

describe("worked example: vendor tariff surcharge", () => {
  const lines: ExistingLine[] = [
    {
      id: "drapery",
      label: "Drapery fabric",
      category: "furniture",
      priceCents: $(2000),
      payment: { kind: "captured", capturedCents: $(2000), poPlaced: true },
    },
    {
      id: "side-table",
      label: "Side table",
      category: "furniture",
      priceCents: $(400),
      payment: { kind: "held", authorizedCents: $(400) },
    },
  ];

  const plan = planChange(
    lines,
    [
      { type: "reprice", lineId: "drapery", newPriceCents: $(2200) },
      { type: "reprice", lineId: "side-table", newPriceCents: $(420) },
    ],
    { hasVault: true },
  );

  it("charges the 10% drapery surcharge ($200) to the saved PayPal", () => {
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "vault_charge", lineId: "drapery", amountCents: $(200) }),
    );
  });

  it("over-captures the 5% side table surcharge ($20) because it fits the $60 allowance", () => {
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "over_capture",
        lineId: "side-table",
        captureCents: $(420),
        extraCents: $(20),
      }),
    );
  });

  it("raises the budget by $220 and moves $220 of new money", () => {
    expect(plan.budgetDeltaCents).toBe($(220));
    expect(plan.money.newChargeCents).toBe($(220));
    expect(plan.money.newHoldCents).toBe(0);
  });
});
