import { describe, expect, it } from "vitest";
import { defaultOpening } from "@/opening/document";
import type { ItemHoldView, ItemHoldsView } from "@/payments/item-holds-view";
import type { ServicesPaymentView } from "@/payments/services-view";
import { willowGuideStep, type WillowGuideData } from "./willow-guide";

const serviceView = (patch: Partial<ServicesPaymentView> = {}): ServicesPaymentView => ({ projectKey: "willow", basis: { version: 1, orderId: null }, services: [{ itemId: "consultation", label: "Consultation", targetCents: 30_000, capturedCents: 30_000, captures: [] }], dueCents: 0, furnitureToHold: { count: 0, cents: 0 }, checkout: null, savedPayPal: true, savedMethod: { kind: "paypal", label: "b•••@personal.example.com", savedAt: "2026-10-30T12:00:00.000Z" }, canRemoveSaved: false, checkoutOptions: null, canPay: false, canFinish: false, canCheck: false, reason: null, paypalClientId: null, ...patch });
const item = (patch: Partial<ItemHoldView> = {}): ItemHoldView => ({ itemId: "chair", side: "baseline", label: "Chair", targetCents: 10_000, heldCents: 10_000, capturedCents: 0, state: "held", operationId: "hold", approvalUrl: null, canCheck: false, canCancel: false, canCancelItem: false, cancellation: null, canCheckout: false, paypalAuthorizationId: "AUTH", expiresAt: null, timing: null, expiredAt: null, renewal: null, failureMessage: null, vendor: "Alder Row", terms: { quantity: 1, unitPriceCents: 10_000, taxCents: 0, freightCents: 0, leadTimeDays: 21 }, supplier: null, ...patch });
const holdsView = (patch: Partial<ItemHoldsView> = {}): ItemHoldsView => ({ clock: { now: "2026-11-01T12:00:00.000Z", simulatedDays: 0 }, projectKey: "willow", basis: { version: 1, orderId: null }, items: [item()], toHoldCents: 0, savedPayPal: true, savedMethod: { kind: "paypal", label: "b•••@personal.example.com", savedAt: "2026-10-30T12:00:00.000Z" }, canRemoveSaved: false, checkoutOptions: null, canHold: false, canConfirmSupplier: true, contentHash: "hash", reason: null, ...patch });
function approved(): WillowGuideData {
  return { snapshot: { opening: { ...defaultOpening("willow"), status: "approved", sentAt: "2026-10-24T00:00:00Z", progress: { approved: 2, declined: 1, withdrawn: 0, pending: 25, approvedTotalCents: 40_000 } }, versions: [] }, services: serviceView(), holds: holdsView() };
}

describe("Willow first-quote guide", () => {
  it("asks Jordan to send a draft without inventing a client approval", () => {
    const data = approved();
    data.snapshot.opening = defaultOpening("willow");
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 0, role: "jordan", destination: "chat" });
  });

  it("lets Sofia sign a small selected scope while other lines remain undecided", () => {
    const data = approved();
    data.snapshot.opening.status = "sent";
    data.snapshot.opening.progress.approved = 0;
    const step = willowGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 1, role: "sofia", destination: "quote" });
    expect(step.detail).toContain("Lines left undecided can be signed later");
  });

  it("proceeds to the selected service payment without requiring all 28 lines", () => {
    const data = approved();
    data.services = serviceView({ dueCents: 30_000, canPay: false, savedPayPal: false });
    const step = willowGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 2, role: "sofia", anchor: "design-services" });
    expect(step.detail).toContain("the same payment then holds each approved furniture item");
  });

  it("asks Jordan to hold only what the services payment left unheld", () => {
    const data = approved();
    data.holds = holdsView({ items: [item(), item({ itemId: "lamp", label: "Lamp", state: "to_hold", heldCents: 0 })], toHoldCents: 10_000, canHold: true });
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 2, role: "jordan", title: "Hold the remaining furniture items", anchor: "item-holds" });
  });

  it("does not infer any payment state from missing or mismatched version records", () => {
    const data = approved();
    data.services = null;
    expect(willowGuideStep(data, "client").title).toContain("Read the approved scope");
    data.services = serviceView({ basis: { version: 2, orderId: "v2" } });
    expect(willowGuideStep(data, "client").title).toContain("Read the approved scope");
  });

  it("asks for a service decision only if no design service is approved", () => {
    const data = approved();
    data.services = serviceView({ services: [], savedPayPal: false });
    expect(willowGuideStep(data, "designer")).toMatchObject({ index: 1, role: "sofia" });
  });

  it("keeps an unknown checkout on the original payment's check action", () => {
    const data = approved();
    data.services = serviceView({ dueCents: 30_000, canCheck: true, canPay: false, savedPayPal: false });
    const step = willowGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 2, role: "jordan", title: "Check the existing service payment" });
    expect(step.detail).toContain("must not become a replacement checkout");
  });

  it("does not label a pending capture as paid even if the displayed due total is zero", () => {
    const data = approved();
    data.services = serviceView({ services: [{ itemId: "consultation", label: "Consultation", targetCents: 30_000, capturedCents: 0, captures: [{ paypalCaptureId: "CAP", amountCents: 30_000, status: "pending", settlement: { state: "missing", feeCents: null, netCents: null, grossCents: 30_000, reason: null, observedAt: null } }] }] });
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 2, title: "Check the existing service payment" });
  });

  it("asks Sofia to hold each item when no payment method was saved, without charging the services again", () => {
    const data = approved();
    data.services!.savedPayPal = false;
    data.holds = { ...data.holds!, savedPayPal: false, savedMethod: null, items: data.holds!.items.map((item) => ({ ...item, state: "to_hold", heldCents: 0, canCheckout: true })) };
    const step = willowGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 2, role: "sofia", title: "Sofia holds each approved item", anchor: "item-holds" });
    expect(step.detail).toContain("does not suggest charging the services again");
  });

  it("uses a further selected furniture approval without requesting all products", () => {
    const data = approved();
    data.holds!.items = [];
    expect(willowGuideStep(data, "designer")).toMatchObject({ index: 1, role: "sofia" });
  });

  it("routes payer action to Sofia and unresolved holds to the same operation", () => {
    const data = approved();
    data.holds!.items = [item({ state: "awaiting_client" })];
    expect(willowGuideStep(data, "designer")).toMatchObject({ index: 2, role: "sofia", anchor: "item-holds" });
    data.holds!.items = [item({ state: "unknown" })];
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 2, role: "jordan", title: "Check unresolved item holds" });
  });

  it("keeps supplier confirmation and capture as separate designer steps", () => {
    const data = approved();
    data.holds!.clock.simulatedDays = 3;
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 3, role: "jordan" });
    expect(willowGuideStep(data, "client").complete).toBeUndefined();
    data.holds!.items = [item({ state: "confirmed" })];
    expect(willowGuideStep(data, "client")).toMatchObject({ index: 4, title: "Capture the supplier-confirmed items" });
  });

  it("marks only the selected captured scope complete", () => {
    const data = approved();
    data.holds!.items = [item({ state: "captured", capturedCents: 10_000, heldCents: 0 })];
    const step = willowGuideStep(data, "client");
    expect(step).toMatchObject({ index: 4, complete: true });
    expect(step.detail).toContain("Undecided and declined lines remain separate");
  });

  describe("when Jordan is busy and forgets to order", () => {
    const at = (days: number, items: ReturnType<typeof item>[]) => {
      const data = approved();
      data.holds = holdsView({ items, clock: { now: "2026-11-01T12:00:00.000Z", simulatedDays: days } });
      return willowGuideStep(data, "designer");
    };

    it("offers to skip ahead 3 days before any supplier order is recorded", () => {
      expect(at(0, [item(), item({ itemId: "desk", label: "Desk" })])).toMatchObject({
        index: 3, title: "What if Jordan is busy and forgets to order?", action: "Skip ahead 3 days", skipTo: 3,
        secondary: { label: "Record the confirmations now", href: "/quotes/willow#item-holds" }, detail: expect.stringMatching(/^Sofia's 2 items are held, but no supplier order is recorded yet\./),
      });
    });

    it("then asks for the confirmations, saying what Setti reminded Jordan of", () => {
      const step = at(3, [item(), item({ itemId: "desk", label: "Desk" })]);
      expect(step).toMatchObject({ index: 3, title: "Jordan checks Chair's supplier confirmation", detail: expect.stringMatching(/^3 days on, Setti's inbox reminds Jordan that 2 items are still not ordered\. /) });
      expect(step.skipTo).toBeUndefined();
    });

    it("does not offer the skip once an order is recorded", () => {
      const step = at(0, [item({ state: "confirmed", supplier: { reference: "SO-1", totalCents: 10_000, leadTimeDays: 10 } }), item({ itemId: "desk", label: "Desk" })]);
      expect(step).toMatchObject({ index: 3, title: "Jordan checks Desk's supplier confirmation" });
      expect(step.skipTo).toBeUndefined();
    });
  });

  it("redirects a replaced V1 to the new version without checking off unpaid steps", () => {
    const data = approved();
    data.snapshot.opening.closed = true;
    data.snapshot.versions = [{ id: "v2", version: 2, basedOnVersion: 1, title: "Revised", messageId: "issued", issuedAt: "2026-10-24T00:00:00Z", changeCount: 1, totalCents: 50_000, deltaTotalCents: 10_000, status: "awaiting_client_confirmation", fromCurrentDraft: true }];
    expect(willowGuideStep(data, "designer")).toMatchObject({ index: 1, role: "sofia", destination: "order", orderId: "v2", anchor: "client-decision-title" });
  });
});
