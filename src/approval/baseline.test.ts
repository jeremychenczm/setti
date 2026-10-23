import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseDocument } from "../chat/cases";
import { approvedForTest } from "../opening/testing";
import { quoteFingerprint } from "../quotes/fingerprint";
import { calculateQuoteTotals } from "../quotes/totals";
import type { FinalQuoteLine, FrozenChangeOrder } from "../pricing/types";
import { approvedQuoteFromOrder } from "./baseline";

function frozenOrder(): FrozenChangeOrder {
  const quote = approvedForTest("willow");
  const lines: FinalQuoteLine[] = quote.lines.map((line) => ({
    itemId: line.itemId, name: line.name, vendor: line.vendor, brand: null, sku: line.sku,
    specification: line.specification, category: line.category, room: line.room,
    quantity: line.quantity, unitLabel: line.unitLabel ?? "each", currency: "USD",
    unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
    sourceUrl: line.source.url ?? null, returnPolicy: line.returnPolicy,
    returnable: line.nonReturnable === null ? null : !line.nonReturnable,
    restockingFeeBps: line.restockingFeeBps, customMade: line.customMade,
    leadTimeDays: line.leadTimeDays, origin: "unchanged",
  }));
  const totals = calculateQuoteTotals(lines);
  return {
    id: randomUUID(), version: 3, issuedAt: "2026-10-20T10:00:00Z", reviewId: randomUUID(),
    reviewVersion: 2, revisionId: randomUUID(), revisionContentHash: "revision-hash",
    contentHash: "whole-document-hash", baselineFingerprint: quoteFingerprint(quote),
    projectKey: "willow", basedOnQuoteId: quote.id, basedOnVersion: quote.version,
    projectName: quote.projectName, clientName: quote.clientName, designerName: quote.designerName,
    currency: "USD", isDemo: true, title: "Confirmed chair change", sourceDraftId: randomUUID(),
    sourceDraftRevision: 2, changes: [], lines, baselineLines: structuredClone([...quote.lines]),
    baselineTotals: totals, totals, deltaTotalCents: 0, terms: "Confirmed demo client terms.",
    reviewNotes: "Designer checked the frozen details.", issues: [], constraints: ["Keep the other furniture."],
    sourceMessages: [], sources: [],
  };
}

const confirmation = { clientName: "Demo customer", signature: "Demo customer", decidedAt: new Date("2026-10-20T11:00:00Z") };

describe("customer-confirmed quote baseline", () => {
  it("uses the confirmed order identity and complete content for subsequent changes", () => {
    const order = frozenOrder();
    const chair = order.lines.find((line) => line.itemId === "willow-dining-chair")!;
    Object.assign(chair, { name: "BERGMUND Chair", quantity: 6, unitPriceCents: 12_500, sku: "NEW-SKU", origin: "changed", sourceUrl: "https://shop.example/new-chair", brand: "IKEA" });
    const quote = approvedQuoteFromOrder(order, confirmation);
    expect(quote).toMatchObject({ id: order.id, version: 3, projectId: "willow", approvedAt: confirmation.decidedAt.toISOString(), signature: confirmation.signature, status: "approved", isDemo: true });
    expect(quote.lines).toHaveLength(order.lines.length);
    expect(quote.lines.find((line) => line.itemId === chair.itemId)).toMatchObject({
      name: "BERGMUND Chair", quantity: 6, unitPriceCents: 12_500, sku: "NEW-SKU",
      source: { kind: "public_reference", url: chair.sourceUrl, checkedAt: order.issuedAt },
      approval: { approvedBy: confirmation.clientName, approvedAt: confirmation.decidedAt.toISOString(), signature: confirmation.signature, isDemo: true },
    });
    expect(calculateQuoteTotals(quote.lines)).toEqual(calculateQuoteTotals(order.lines));
    expect(quote.assumptions).toContain(order.terms);
    expect(quote.assumptions).toContain(order.constraints[0]);
    expect(quoteFingerprint(quote)).not.toBe(quoteFingerprint(approvedForTest("willow")));
    expect(quoteFingerprint(approvedQuoteFromOrder(order, confirmation))).toBe(quoteFingerprint(quote));
  });

  it("keeps unknown return eligibility, unit details and retained old-item costs in the next baseline", () => {
    const order = frozenOrder();
    const line = order.lines[0];
    line.returnable = null;
    line.unitLabel = "pair";
    line.taxCents = 234;
    line.freightCents = 567;
    const cost: FinalQuoteLine = {
      ...structuredClone(line), itemId: "old-cost-chair", name: "Retained chair handling cost", category: "service",
      quantity: 1, unitLabel: "fee", unitPriceCents: 2_500, taxCents: 0, freightCents: 0,
      sourceUrl: null, origin: "old_item_cost", returnPolicy: "Confirmed handling fee.",
    };
    order.lines.push(cost);
    const result = approvedQuoteFromOrder(order, confirmation);
    expect(result.lines[0]).toMatchObject({ nonReturnable: null, unitLabel: "pair", taxCents: 234, freightCents: 567 });
    expect(result.lines.find((item) => item.itemId === cost.itemId)).toMatchObject({
      category: "service", quantity: 1, unitPriceCents: 2_500, unitLabel: "fee", returnPolicy: cost.returnPolicy,
    });
    expect(calculateQuoteTotals(result.lines)).toEqual(calculateQuoteTotals(order.lines));
  });

  it("preserves unchanged source evidence without mutating the signed order or fixture", () => {
    const order = frozenOrder();
    const before = structuredClone(order);
    const original = structuredClone(caseDocument("willow"));
    const quote = approvedQuoteFromOrder(order, confirmation);
    expect(quote.lines[0].source).toEqual(order.baselineLines[0].source);
    quote.lines[0].source.note = "An unsaved local edit";
    quote.lines[0].approval.signature = "An unsaved signature";
    expect(order).toEqual(before);
    expect(caseDocument("willow")).toEqual(original);
  });
});

