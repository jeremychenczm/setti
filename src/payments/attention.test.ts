import { describe, expect, it } from "vitest";
import { projectAttention, sortAttention } from "./attention";
import type { ItemHoldView, ItemHoldsView } from "./item-holds-view";

const DAY = 24 * 60 * 60 * 1000;
const authorizedAt = new Date("2026-11-01T18:00:00.000Z");
const at = (days: number) => new Date(authorizedAt.getTime() + days * DAY);
const timing = { authorizedAt: authorizedAt.toISOString(), honorEndsAt: at(3).toISOString(), expiresAt: at(29).toISOString() };
const saved = { kind: "paypal" as const, label: "b•••@personal.example.com", savedAt: authorizedAt.toISOString() };

const item = (patch: Partial<ItemHoldView> = {}): ItemHoldView => ({
  itemId: "willow-armchair", side: "baseline", label: "Lounge armchair", targetCents: 16_204, heldCents: 16_204, capturedCents: 0, state: "held",
  operationId: "hold", approvalUrl: null, canCheck: false, canCancel: false, canCancelItem: true, cancellation: null, canCheckout: false,
  paypalAuthorizationId: "AUTH", expiresAt: timing.expiresAt, timing, expiredAt: null, failureMessage: null, vendor: "Alder Row Furniture",
  terms: null, supplier: null, ...patch,
});
const view = (items: ItemHoldView[], patch: Partial<ItemHoldsView> = {}): ItemHoldsView => ({
  projectKey: "willow", basis: { version: 1, orderId: null }, items, toHoldCents: 0, savedPayPal: true, savedMethod: saved, canRemoveSaved: false,
  checkoutOptions: null, canHold: false, canConfirmSupplier: true, contentHash: "hash", reason: null, ...patch,
});
const one = (line: ItemHoldView, now: Date, patch: Partial<ItemHoldsView> = {}) => projectAttention(view([line], patch), "Willow Residence", now);

describe("what needs the designer today", () => {
  it("waits a day, then asks for the supplier's confirmation while capture is still assured", () => {
    expect(one(item(), at(0.9))).toEqual([]);
    expect(one(item(), at(1))).toEqual([expect.objectContaining({
      kind: "supplier_unconfirmed", urgency: "soon", projectName: "Willow Residence", title: "Lounge armchair · supplier hasn't confirmed",
      detail: "Alder Row Furniture · hold day 2 of 3. Capture is assured until Nov 4.", href: "/quotes/willow?hold=willow-armchair#item-holds",
    })]);
    expect(one(item(), at(2.5))[0]).toMatchObject({ kind: "supplier_unconfirmed", urgency: "now", detail: expect.stringMatching(/hold day 3 of 3/) });
  });

  it("says capture is no longer assured once the 3-day honor period ends", () => {
    expect(one(item(), at(3))[0]).toMatchObject({ kind: "honor_lapsed", urgency: "now", detail: expect.stringMatching(/no longer assured\. Confirm the order or cancel the hold\./) });
  });

  it("asks to capture a confirmed item, sooner once capture is not assured", () => {
    const confirmed = item({ state: "confirmed", supplier: { reference: "SO-1", totalCents: 16_204, leadTimeDays: 10 } });
    expect(one(confirmed, at(0.5))[0]).toMatchObject({ kind: "capture_ready", urgency: "soon", detail: "Alder Row Furniture confirmed the order. Capture is assured until Nov 4." });
    expect(one(confirmed, at(5))[0]).toMatchObject({ kind: "capture_ready", urgency: "now", detail: expect.stringMatching(/no longer assured/) });
    expect(one(confirmed, at(23))[0].detail).toMatch(/The hold expires Nov 30\./);
  });

  it("warns a week before the 29 days run out, and says what happens next", () => {
    expect(one(item(), at(21.9))[0].kind).toBe("honor_lapsed");
    expect(one(item(), at(22))[0]).toMatchObject({ kind: "expiring", urgency: "soon", title: "Lounge armchair · hold expires Nov 30", detail: expect.stringMatching(/A new hold can replace it with the client's saved payment method, without asking the client again\./) });
    expect(one(item(), at(22), { savedMethod: null, savedPayPal: false })[0]).toMatchObject({ kind: "expiring", urgency: "now", detail: expect.stringMatching(/the client has to approve a new hold/) });
  });

  it("flags a hold that expired, whether or not the ledger has caught up", () => {
    expect(one(item(), at(29))[0]).toMatchObject({ kind: "expired", urgency: "now", detail: expect.stringMatching(/ended on Nov 30/) });
    expect(one(item({ state: "to_hold", heldCents: 0, timing: null, expiredAt: at(29).toISOString() }), at(30))[0]).toMatchObject({ kind: "expired", detail: expect.stringMatching(/lapsed on Nov 30/) });
  });

  it("puts open and failed PayPal steps first", () => {
    expect(one(item({ state: "unknown" }), at(0))[0]).toMatchObject({ kind: "payment_unknown", urgency: "now" });
    expect(one(item({ state: "failed", failureMessage: "PayPal declined the hold." }), at(0))[0]).toMatchObject({ kind: "hold_failed", detail: "PayPal declined the hold." });
  });

  it("leaves captured, cancelled and not-yet-held items alone", () => {
    for (const state of ["captured", "cancelled", "to_hold", "holding", "awaiting_client"] as const) expect(one(item({ state }), at(10))).toEqual([]);
  });

  it("links a later version's items to that version's payments page", () => {
    expect(one(item(), at(1), { basis: { version: 2, orderId: "order-2" } })[0].href).toBe("/change-orders/order-2#payment-line-baseline-willow-armchair");
  });

  it("lists what to do today first", () => {
    const items = projectAttention(view([
      item({ itemId: "a", label: "A" }),
      item({ itemId: "b", label: "B", state: "unknown" }),
      item({ itemId: "c", label: "C", timing: { ...timing, authorizedAt: at(-3).toISOString(), honorEndsAt: at(0).toISOString() } }),
    ]), "Willow Residence", at(1));
    expect(sortAttention(items).map((entry) => [entry.itemId, entry.kind, entry.urgency])).toEqual([
      ["b", "payment_unknown", "now"], ["c", "honor_lapsed", "now"], ["a", "supplier_unconfirmed", "soon"],
    ]);
  });
});
