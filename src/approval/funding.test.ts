import { describe, expect, it } from "vitest";
import { buildFundingPlan, type FundingFacts, type FundingLineFact } from "./funding";
import { calculateQuoteTotals } from "../quotes/totals";
import type { ApprovedQuoteLine } from "../quotes/types";
import type { FinalQuoteLine, FrozenChangeOrder, OldItemHandling, ReviewedChange } from "../pricing/types";

const before: ApprovedQuoteLine = {
  itemId: "chairs", name: "Old chair", vendor: "IKEA", category: "furniture", room: "Dining",
  sku: "old", specification: "Oak", quantity: 4, unitLabel: "each",
  unitPriceCents: 8000, taxCents: 2800, freightCents: 0,
  source: { kind: "demo", reference: "old", name: "Original quote", note: "demo" },
  leadTimeDays: null, returnPolicy: "Checked", restockingFeeBps: null, customMade: false, nonReturnable: false,
  approval: { status: "approved", approvedBy: "Client", approvedAt: "2026-10-20T10:00:00.000Z", signature: "Demo Client", isDemo: true },
};
const after: FinalQuoteLine = {
  itemId: "chairs", name: "New chair", vendor: "IKEA", brand: "IKEA", sku: "new",
  specification: "New oak chair", category: "furniture", room: "Dining", quantity: 4,
  unitLabel: "each", currency: "USD", unitPriceCents: 12500, taxCents: 4375, freightCents: 0,
  sourceUrl: null, returnPolicy: "Checked", returnable: true, restockingFeeBps: null,
  customMade: false, leadTimeDays: null, origin: "changed",
};

function order(options: { handling?: OldItemHandling; cost?: number; action?: ReviewedChange["action"]; after?: FinalQuoteLine } = {}): FrozenChangeOrder {
  const action = options.action ?? "replace";
  const next = options.after ?? after;
  const cost = options.cost ?? 0;
  const change: ReviewedChange = {
    key: "change-0", action, itemId: "chairs", before, after: action === "remove" ? null : next,
    oldItemHandling: options.handling ?? "not_ordered", oldItemCostCents: cost, oldItemNote: "Checked", priceEvidence: "Checked",
  };
  const lines: FinalQuoteLine[] = action === "remove" ? [] : [next];
  if (cost) lines.push({
    ...after, itemId: "old-cost-draft-1-change-0", name: "Reviewed old-item cost", category: "service",
    quantity: 1, unitPriceCents: cost, taxCents: 0, freightCents: 0, origin: "old_item_cost",
  });
  const baselineTotals = calculateQuoteTotals([before]);
  const totals = calculateQuoteTotals(lines);
  return {
    id: "order-1", version: 3, issuedAt: "2026-10-20T10:10:00.000Z", reviewId: "review-1", reviewVersion: 2,
    revisionId: "revision-1", revisionContentHash: "revision-hash", contentHash: "full-hash",
    baselineFingerprint: "baseline", projectKey: "willow", basedOnQuoteId: "quote-1", basedOnVersion: 1,
    projectName: "Willow", clientName: "Client", designerName: "Designer", currency: "USD", isDemo: true,
    title: "Chair replacement", sourceDraftId: "draft-1", sourceDraftRevision: 1,
    changes: [change], lines, baselineLines: [before], baselineTotals, totals,
    deltaTotalCents: totals.totalCents - baselineTotals.totalCents, terms: "Checked", reviewNotes: "",
    issues: [], constraints: [], sourceMessages: [], sources: [],
  };
}

const checkedAt = "2026-10-20T11:00:00.000Z";
function fact(value: Partial<FundingLineFact> = {}): FundingLineFact {
  return { itemId: "chairs", heldCents: 0, capturedCents: 0, refundedCents: 0, ...value };
}
function facts(...lines: FundingLineFact[]): FundingFacts {
  return { status: lines.length ? "recorded" : "no_records", checkedAt, lines };
}

describe("buildFundingPlan", () => {
  it("keeps the quote difference separate from full funding when no money exists", () => {
    const plan = buildFundingPlan(order(), facts());
    expect(plan).toMatchObject({
      orderId: "order-1", contentHash: "full-hash", basedOnVersion: 1, version: 3,
      quoteDeltaCents: 19575, factsAsOf: checkedAt, status: "not_authorized", executable: false,
      current: { heldCents: 0, capturedCents: 0, refundedCents: 0 },
      money: { newAuthorizationCents: 54375, releaseCents: 0, chargeCents: 0, refundCents: 0 },
    });
    expect(plan.notices.join(" ")).toContain("full proposed quote still needs funding");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ side: "proposed", kind: "new_authorization", amountCents: 54375 });
  });

  it("releases the old hold and proposes full funding for the replacement", () => {
    const plan = buildFundingPlan(order(), facts(fact({ heldCents: 34800 })));
    expect(plan.status).toBe("preview");
    expect(plan.money).toEqual({ newAuthorizationCents: 54375, releaseCents: 34800, chargeCents: 0, refundCents: 0 });
    expect(plan.actions.find((action) => action.kind === "release_authorization")?.timing).toBe("on_payment_execution");
  });

  it("does not count old captured money as payment for the new product with the same document ID", () => {
    const plan = buildFundingPlan(order(), facts(fact({ capturedCents: 34800 })));
    expect(plan.money).toMatchObject({ newAuthorizationCents: 54375, refundCents: 34800, chargeCents: 0 });
    expect(plan.actions.find((action) => action.kind === "refund")).toMatchObject({ side: "baseline", timing: "on_payment_execution" });
  });

  it("does not charge an already paid retained old-item cost again", () => {
    const plan = buildFundingPlan(order({ handling: "retained", cost: 34800 }), facts(fact({ capturedCents: 34800 })));
    expect(plan.money).toEqual({ newAuthorizationCents: 54375, releaseCents: 0, chargeCents: 0, refundCents: 0 });
    expect(plan.actions).toHaveLength(1);
  });

  it("deducts exact reviewed return costs once and waits for the vendor credit", () => {
    const plan = buildFundingPlan(order({ handling: "returned", cost: 5000 }), facts(fact({ capturedCents: 34800 })));
    expect(plan.money).toMatchObject({ newAuthorizationCents: 54375, chargeCents: 0, refundCents: 29800 });
    expect(plan.actions.find((action) => action.kind === "refund")?.timing).toBe("after_vendor_credit");
    expect(plan.notices.join(" ")).toContain("conditional refund");
  });

  it("marks an already verified vendor credit as eligible for the later execution step", () => {
    const plan = buildFundingPlan(order({ handling: "returned", cost: 5000 }), facts(fact({ capturedCents: 34800, vendorCreditConfirmed: true })));
    expect(plan.actions.find((action) => action.kind === "refund")?.timing).toBe("on_payment_execution");
    expect(plan.executable).toBe(false);
  });

  it("subtracts completed prior refunds instead of promising the refund twice", () => {
    const plan = buildFundingPlan(order({ handling: "returned", cost: 5000 }), facts(fact({ capturedCents: 34800, refundedCents: 10000 })));
    expect(plan.money.refundCents).toBe(19800);
    expect(plan.current.refundedCents).toBe(10000);
  });

  it("handles a partial capture and remaining authorization as separate funds", () => {
    const plan = buildFundingPlan(order({ handling: "returned", cost: 5000 }), facts(fact({ capturedCents: 10000, heldCents: 24800 })));
    expect(plan.money).toMatchObject({ newAuthorizationCents: 54375, refundCents: 5000, releaseCents: 24800, chargeCents: 0 });
  });

  it("recognizes settled proposed-product funding independently of the old hold", () => {
    const plan = buildFundingPlan(order(), facts(
      fact({ heldCents: 34800 }),
      fact({ side: "proposed", capturedCents: 54375 }),
    ));
    expect(plan.money).toEqual({ newAuthorizationCents: 0, releaseCents: 34800, chargeCents: 0, refundCents: 0 });
  });

  it("nets a quantity reduction and its old-item cost against the original captured line", () => {
    const reduced = { ...after, name: before.name, sku: before.sku, specification: before.specification, quantity: 2, unitPriceCents: 8000, taxCents: 1400 };
    const plan = buildFundingPlan(order({ action: "quantity", after: reduced, cost: 2000, handling: "returned" }), facts(fact({ capturedCents: 34800 })));
    expect(plan.money).toEqual({ newAuthorizationCents: 0, releaseCents: 0, chargeCents: 0, refundCents: 15400 });
    expect(plan.actions).toHaveLength(1);
  });

  it("only releases a partial hold through the later capture-and-close step", () => {
    const reduced = { ...after, quantity: 2, unitPriceCents: 8000, taxCents: 1400 };
    const plan = buildFundingPlan(order({ action: "quantity", after: reduced, cost: 2000 }), facts(fact({ heldCents: 34800 })));
    expect(plan.money).toEqual({ newAuthorizationCents: 0, releaseCents: 15400, chargeCents: 19400, refundCents: 0 });
    expect(plan.actions.every((action) => action.timing === "after_vendor_confirmation")).toBe(true);
  });

  it("funds the complete approved quote including unchanged services", () => {
    const value = order();
    const serviceBefore: ApprovedQuoteLine = { ...before, itemId: "design", name: "Design", category: "service", quantity: 1, unitPriceCents: 10000, taxCents: 0 };
    const serviceAfter: FinalQuoteLine = { ...after, ...serviceBefore, brand: null, currency: "USD", unitLabel: "each", returnable: true, sourceUrl: null, origin: "unchanged" };
    value.baselineLines.push(serviceBefore); value.lines.push(serviceAfter);
    value.baselineTotals = calculateQuoteTotals(value.baselineLines); value.totals = calculateQuoteTotals(value.lines);
    const plan = buildFundingPlan(value, facts());
    expect(plan.money).toEqual({ newAuthorizationCents: 54375, releaseCents: 0, chargeCents: 10000, refundCents: 0 });
  });

  it("blocks every monetary promise when a provider result is pending or unknown", () => {
    const plan = buildFundingPlan(order(), facts(fact({ capturedCents: 34800, uncertainReason: "Refund pending; provider result is not settled." })));
    expect(plan.status).toBe("blocked");
    expect(plan.money).toEqual({ newAuthorizationCents: null, releaseCents: null, chargeCents: null, refundCents: null });
    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toContain("Refund pending; provider result is not settled.");
  });

  it("blocks project-wide unallocated funds before suggesting new funding", () => {
    const plan = buildFundingPlan(order(), { ...facts(), status: "recorded", blockers: ["A project authorization has no item allocation."] });
    expect(plan.status).toBe("blocked");
    expect(plan.actions).toEqual([]);
    expect(plan.money.newAuthorizationCents).toBeNull();
  });

  it("rejects duplicate fact mappings rather than double-counting money", () => {
    const plan = buildFundingPlan(order(), facts(fact({ heldCents: 10000 }), fact({ heldCents: 10000 })));
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toContain("aggregate each business item exactly once");
  });

  it("rejects funds mapped to unknown document items", () => {
    const plan = buildFundingPlan(order(), facts(fact({ itemId: "unrelated" })));
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toContain("cannot be attributed");
  });

  it.each([
    { heldCents: -1 }, { capturedCents: 1.5 }, { refundedCents: 1 }, { heldCents: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid balances: %j", (value) => {
    expect(buildFundingPlan(order(), facts(fact(value))).status).toBe("blocked");
  });

  it("blocks contradictory no-records metadata", () => {
    const plan = buildFundingPlan(order(), { ...facts(fact()), status: "no_records" });
    expect(plan.status).toBe("blocked");
  });

  it("blocks an invalid funding check time", () => {
    const plan = buildFundingPlan(order(), { ...facts(), checkedAt: "not a date" });
    expect(plan.status).toBe("blocked");
  });

  it("blocks old-item costs that are missing their exact frozen fee line", () => {
    const value = order({ handling: "returned", cost: 5000 });
    value.lines = value.lines.filter((line) => line.origin !== "old_item_cost");
    value.totals = calculateQuoteTotals(value.lines); value.deltaTotalCents = value.totals.totalCents - value.baselineTotals.totalCents;
    const plan = buildFundingPlan(value, facts(fact({ capturedCents: 34800 })));
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.join(" ")).toContain("old-item cost");
  });

  it("rejects tampered totals instead of using a quoted delta as money", () => {
    const value = order(); value.deltaTotalCents = 1;
    expect(buildFundingPlan(value, facts()).status).toBe("blocked");
  });

  it("does not mutate frozen documents or facts and gives stable repeat previews", () => {
    const value = order({ handling: "returned", cost: 5000 });
    const records = facts(fact({ capturedCents: 34800, refundedCents: 10000 }));
    const original = JSON.stringify({ value, records });
    const first = buildFundingPlan(value, records);
    expect(buildFundingPlan(value, records)).toEqual(first);
    expect(JSON.stringify({ value, records })).toBe(original);
  });
});

