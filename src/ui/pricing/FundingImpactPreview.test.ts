import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FundingPlan } from "../../approval/funding";
import { FundingImpactPreview } from "./FundingImpactPreview";

const order = { id: "mixed-order", version: 3, basedOnVersion: 2, contentHash: "frozen-hash", deltaTotalCents: 6_000 };

function plan(): FundingPlan {
  return {
    orderId: order.id, contentHash: order.contentHash, version: 3, basedOnVersion: 2,
    quoteDeltaCents: 6_000, factsAsOf: "2026-10-21T20:00:00Z", status: "preview", executable: false,
    current: { heldCents: 80_000, capturedCents: 30_000, refundedCents: 0 },
    money: { newAuthorizationCents: 110_000, releaseCents: 80_000, chargeCents: 40_000, refundCents: 24_000 },
    lines: [
      { itemId: "chair", side: "baseline", label: "Old chair", category: "service", changed: true, change: "replace", targetCents: 0, heldCents: 80_000, capturedCents: 0, refundedCents: 0 },
      { itemId: "chair", side: "proposed", label: "New desk", category: "furniture", changed: true, change: "replace", targetCents: 110_000, heldCents: 0, capturedCents: 0, refundedCents: 0 },
      { itemId: "rug", side: "baseline", label: "Wool rug", category: "service", changed: true, change: "remove", targetCents: 6_000, heldCents: 0, capturedCents: 30_000, refundedCents: 0 },
      { itemId: "design", side: "baseline", label: "Design services", category: "service", changed: false, change: null, targetCents: 40_000, heldCents: 0, capturedCents: 0, refundedCents: 0 },
    ],
    actions: [
      { itemId: "chair", side: "baseline", label: "Old chair", kind: "release_authorization", amountCents: 80_000, timing: "on_payment_execution", reason: "Release an unused hold; this is not a refund." },
      { itemId: "chair", side: "proposed", label: "New desk", kind: "new_authorization", amountCents: 110_000, timing: "on_payment_execution", reason: "The new desk has its own authorization." },
      { itemId: "rug", side: "baseline", label: "Wool rug", kind: "refund", amountCents: 24_000, timing: "after_vendor_credit", reason: "Refund $240 after supplier credit; the reviewed $60 retained cost is deducted once." },
      { itemId: "design", side: "baseline", label: "Design services", kind: "capture", amountCents: 40_000, timing: "on_payment_execution", reason: "The unchanged design service needs separate funding." },
    ],
    blockers: [], notices: ["This preview does not move money.", "Furniture funding remains subject to vendor confirmation."],
  };
}

function render(value: FundingPlan | null = plan(), props: Partial<Parameters<typeof FundingImpactPreview>[0]> = {}) {
  return renderToStaticMarkup(createElement(FundingImpactPreview, { order, plan: value, status: "awaiting_client_confirmation", canView: true, ...props }));
}

describe("client funding impact preview", () => {
  it("separates the budget difference from authorization, release and conditional refund", () => {
    const html = render();
    expect(html).toContain("Payment impact before you confirm · V3");
    expect(html).toContain("+$60.00");
    expect(html).toContain("$1,100.00");
    expect(html).toContain("$800.00");
    expect(html).toContain("$240.00");
    expect(html).toContain("Authorization to release");
    expect(html).toContain("Releasing a hold is not a refund");
    expect(html).toContain("After supplier credit is verified");
    expect(html).toContain("client approves on PayPal");
    expect(html).toContain("does not query PayPal live");
    expect(html).toMatch(/datetime="2026-10-21T20:00:00Z"/i);
    expect(html).toContain("does not authorize, capture, release or refund funds");
    expect(html).not.toContain("<button");
  });

  it("keeps unfunded unchanged lines outside the changed-item totals and visible", () => {
    const html = render();
    const changed = html.slice(html.indexOf("Payment impact of changed items"), html.indexOf("Other quote lines still need funding"));
    expect(changed).not.toContain("$400.00");
    expect(html).toContain("Other quote lines still need funding");
    expect(html).toContain("Design services");
    expect(html).toContain("$400.00");
    expect(html).toContain("Their quote approval does not mean they have been paid");
  });

  it("shows supplier confirmation as a dependency of a planned capture", () => {
    const value = plan();
    value.actions.push({ itemId: "chair", side: "proposed", label: "New desk", kind: "capture", amountCents: 110_000, timing: "after_vendor_confirmation", reason: "Capture only after the reviewed supplier terms are confirmed." });
    value.money.chargeCents = 150_000;
    const html = render(value);
    expect(html).toContain("After supplier confirmation");
    expect(html).toContain("Capture only after the reviewed supplier terms are confirmed.");
  });

  it("shows blocked money as unavailable instead of settled zero or executable actions", () => {
    const value = plan();
    value.status = "blocked";
    value.blockers = ["A refund has an unknown provider outcome."];
    value.money = { newAuthorizationCents: null, releaseCents: null, chargeCents: null, refundCents: null };
    const html = render(value);
    expect(html).toContain("Payment amounts need verification");
    expect(html).toContain("An unknown outcome is not a zero balance");
    expect(html).toContain("A refund has an unknown provider outcome.");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("$1,100.00");
    expect(html).not.toContain("<table");
  });

  it("does not invent money when the preview is missing", () => {
    const html = render(null);
    expect(html).toContain("Payment impact is unavailable from the saved records");
    expect(html).toContain("No payment amounts are assumed");
    expect(html).not.toContain("$0.00");
  });

  it("makes no-record assumptions visible when the server can plan new funding", () => {
    const value = plan();
    value.status = "not_authorized";
    value.actions = value.actions.filter((action) => action.kind === "new_authorization" || action.itemId === "design");
    value.money.releaseCents = 0;
    value.money.refundCents = 0;
    const html = render(value);
    expect(html).toContain("No PayPal funding records are saved for this project");
    expect(html).toContain("Existing quote approvals do not count as payments");
    expect(html).toContain("$1,100.00");
    expect(html).not.toContain("$800.00");
  });

  it.each(["orderId", "version", "contentHash", "quoteDeltaCents"] as const)("rejects %s drift from the displayed frozen version", (field) => {
    const value = plan();
    if (field === "orderId") value.orderId = "other-order";
    else if (field === "contentHash") value.contentHash = "another-hash";
    else value[field] += 1;
    expect(render(value)).toContain("does not match this exact quote version");
    expect(render(value)).not.toContain("$1,100.00");
  });

  it("hides payment details on a shared quote even if a plan is accidentally supplied", () => {
    const html = render(plan(), { canView: false });
    expect(html).toContain("This shared quote remains read-only");
    expect(html).not.toContain("$800.00");
    expect(html).not.toContain("before you confirm");
  });

  it("labels superseded and requested-adjustment versions without current payment instructions", () => {
    const historical = render(plan(), { status: "superseded" });
    expect(historical).toContain("Historical payment plan");
    expect(historical).toContain("Review the latest client version");
    expect(historical).not.toContain("$1,100.00");
    const declined = render(plan(), { status: "declined" });
    expect(declined).toContain("The designer must issue a new version");
    expect(declined).not.toContain("before you confirm");
  });

  it("makes clear an approved version shows remaining steps from current records", () => {
    const html = render(plan(), { status: "approved" });
    expect(html).toContain("Remaining payment plan · V3");
    expect(html).toContain("not a snapshot taken at approval");
  });

  it("escapes labels, reasons and blockers instead of executing supplier text", () => {
    const value = plan();
    value.actions[0].label = '<script>alert("item")</script>';
    value.actions[0].reason = '<img src=x onerror="alert(1)">';
    const html = render(value);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
});
