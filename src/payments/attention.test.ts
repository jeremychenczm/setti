import { describe, expect, it } from "vitest";
import { projectAttention, renewalNotice, renewalNoticesDue, sortAttention } from "./attention";
import type { ItemHoldView, ItemHoldsView } from "./item-holds-view";

const DAY = 24 * 60 * 60 * 1000;
const authorizedAt = new Date("2026-11-01T18:00:00.000Z");
const at = (days: number) => new Date(authorizedAt.getTime() + days * DAY);
const timing = { holdId: "hold-chair", authorizedAt: authorizedAt.toISOString(), honorEndsAt: at(3).toISOString(), expiresAt: at(29).toISOString(), renewed: false };
const saved = { kind: "paypal" as const, label: "b•••@personal.example.com", savedAt: authorizedAt.toISOString() };

const item = (patch: Partial<ItemHoldView> = {}): ItemHoldView => ({
  itemId: "fernhill-chair", side: "baseline", label: "Dining chair", targetCents: 34_560, heldCents: 34_560, capturedCents: 0, state: "held",
  operationId: "hold", approvalUrl: null, canCheck: false, canCancel: false, canCancelItem: true, cancellation: null, canCheckout: false,
  paypalAuthorizationId: "AUTH", expiresAt: timing.expiresAt, timing, expiredAt: null, renewal: null, failureMessage: null, vendor: "Northwood Furniture",
  terms: null, supplier: null, ...patch,
});
const view = (items: ItemHoldView[], patch: Partial<ItemHoldsView> = {}): ItemHoldsView => ({
  clock: { now: authorizedAt.toISOString(), simulatedDays: 0 },
  projectKey: "fernhill", basis: { version: 1, orderId: null }, items, toHoldCents: 0, savedPayPal: true, savedMethod: saved, canRemoveSaved: false,
  checkoutOptions: null, canHold: false, canConfirmSupplier: true, contentHash: "hash", reason: null, ...patch,
});
const one = (line: ItemHoldView, now: Date, patch: Partial<ItemHoldsView> = {}) => projectAttention(view([line], patch), "Fernhill Apartment", now);

describe("what needs the designer today", () => {
  it("says nothing for three days, then reminds once that the item was not ordered", () => {
    expect(one(item(), at(1))).toEqual([]);
    expect(one(item(), at(2.99))).toEqual([]);
    expect(one(item(), at(3))).toEqual([expect.objectContaining({
      kind: "not_ordered", urgency: "now", projectName: "Fernhill Apartment", title: "Dining chair · not ordered yet",
      detail: "Approved and held for 3 days, but no order with Northwood Furniture is recorded. After PayPal's 3-day honor period, capture is no longer assured: place the order and record the supplier's confirmation.",
      href: "/quotes/fernhill?hold=fernhill-chair#item-holds",
    })]);
    expect(one(item(), at(5))[0]).toMatchObject({ kind: "not_ordered", detail: expect.stringMatching(/^Approved and held for 5 days/) });
  });

  it("asks to capture a confirmed item, sooner once capture is not assured", () => {
    const confirmed = item({ state: "confirmed", supplier: { reference: "SO-1", totalCents: 34_560, leadTimeDays: 10 } });
    expect(one(confirmed, at(0.5))[0]).toMatchObject({ kind: "capture_ready", urgency: "soon", detail: "Northwood Furniture confirmed the order. Capture is assured until Nov 4." });
    expect(one(confirmed, at(5))[0]).toMatchObject({ kind: "capture_ready", urgency: "now", detail: expect.stringMatching(/no longer assured/) });
    expect(one(confirmed, at(23))[0].detail).toMatch(/The hold expires Nov 30\./);
  });

  it("warns a week before the 29 days run out, and says what happens next", () => {
    expect(one(item(), at(21.9))[0].kind).toBe("not_ordered");
    expect(one(item(), at(22))[0]).toMatchObject({ kind: "expiring", urgency: "soon", title: "Dining chair · hold expires Nov 30", detail: expect.stringMatching(/Setti renews it on Nov 26 with the client's saved payment method\./) });
    expect(one(item(), at(22), { savedMethod: null, savedPayPal: false })[0]).toMatchObject({ kind: "expiring", urgency: "now", detail: expect.stringMatching(/the client has to approve a new hold/) });
  });

  it("flags a hold that expired, whether or not the ledger has caught up", () => {
    expect(one(item(), at(29))[0]).toMatchObject({ kind: "expired", urgency: "now", detail: expect.stringMatching(/ended on Nov 30/) });
    expect(one(item({ state: "to_hold", heldCents: 0, timing: null, expiredAt: at(29).toISOString() }), at(30))[0]).toMatchObject({ kind: "expired", detail: expect.stringMatching(/lapsed on Nov 30/) });
  });

  it("says so when Setti could not renew a hold", () => {
    const failed = item({ renewal: { message: "PayPal refused the saved payment method.", at: at(25).toISOString() } });
    expect(one(failed, at(25.1))[0]).toMatchObject({
      kind: "renewal_failed", urgency: "now", title: "Dining chair · renewal failed",
      detail: "Setti could not renew the hold: PayPal refused the saved payment method. The current hold still ends Nov 30. Ask the client to approve a new hold, or cancel the item.",
    });
  });

  it("puts open and failed PayPal steps first", () => {
    expect(one(item({ state: "unknown" }), at(0))[0]).toMatchObject({ kind: "payment_unknown", urgency: "now" });
    expect(one(item({ state: "failed", failureMessage: "PayPal declined the hold." }), at(0))[0]).toMatchObject({ kind: "hold_failed", detail: "PayPal declined the hold." });
  });

  it("leaves captured, cancelled and not-yet-held items alone", () => {
    for (const state of ["captured", "cancelled", "to_hold", "holding", "awaiting_client"] as const) expect(one(item({ state }), at(10))).toEqual([]);
  });

  it("links a later version's items to that version's payments page", () => {
    expect(one(item(), at(3), { basis: { version: 2, orderId: "order-2" } })[0].href).toBe("/quotes/fernhill?v=2#payment-line-baseline-fernhill-chair");
  });

  it("gives the renewal notice only to unconfirmed holds in their last week, with a saved method", () => {
    const lines = [item(), item({ itemId: "desk", state: "confirmed" }), item({ itemId: "rug", state: "cancelled" })];
    expect(renewalNoticesDue(view(lines), at(21.9))).toEqual([]);
    expect(renewalNoticesDue(view(lines), at(22)).map((line) => line.itemId)).toEqual(["fernhill-chair"]);
    expect(renewalNoticesDue(view(lines), at(29))).toEqual([]);
    expect(renewalNoticesDue(view(lines, { savedMethod: null, savedPayPal: false }), at(23))).toEqual([]);
    expect(renewalNotice({ lines: [item()], client: "Ava Chen", designer: "Jordan Lee", method: { kind: "card", label: "Visa •••• 0026" }, now: at(22) }))
      .toBe("Heads-up for Ava and Jordan: the $345.60 hold for Dining chair ends Nov 30, because PayPal holds last 29 days, and Northwood Furniture hasn't confirmed the order yet. On Nov 26 Setti will replace it with a new hold of the same amount on Ava's saved card (Visa •••• 0026), so nothing is charged and Ava doesn't need to do anything. If the project or this item has stopped, Jordan can cancel the hold before then.");
  });

  it("puts a project's holds that came due together into one notice", () => {
    const lines = Array.from({ length: 10 }, (_, index) => item({ itemId: `item-${index}`, label: `Item ${index + 1}`, heldCents: 1_000 }));
    const text = renewalNotice({ lines, client: "Ava Chen", designer: "Jordan Lee", method: { kind: "paypal", label: "b•••@personal.example.com" }, now: at(22) });
    expect(text.split("\n")).toEqual([
      "Heads-up for Ava and Jordan: 10 holds end Nov 30, because PayPal holds last 29 days, and their suppliers haven't confirmed the orders yet:",
      ...Array.from({ length: 8 }, (_, index) => `• Item ${index + 1} · $10.00`),
      "• and 2 more: Item 9, Item 10",
      "On Nov 26 Setti will replace each with a new hold of the same amount on Ava's saved PayPal ($100.00 in all), so nothing is charged and Ava doesn't need to do anything. If the project or any of these items has stopped, Jordan can cancel those holds before then.",
    ]);
  });

  it("lists what to do today first", () => {
    const items = projectAttention(view([
      item({ itemId: "a", label: "A" }),
      item({ itemId: "b", label: "B", state: "unknown" }),
      item({ itemId: "c", label: "C", timing: { ...timing, authorizedAt: at(-3).toISOString(), honorEndsAt: at(0).toISOString() } }),
      item({ itemId: "d", label: "D", state: "confirmed", supplier: { reference: "SO-1", totalCents: 34_560, leadTimeDays: 10 } }),
    ]), "Fernhill Apartment", at(1));
    expect(sortAttention(items).map((entry) => [entry.itemId, entry.kind, entry.urgency])).toEqual([
      ["b", "payment_unknown", "now"], ["c", "not_ordered", "now"], ["d", "capture_ready", "soon"],
    ]);
  });
});
