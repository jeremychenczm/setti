import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FundingPlan } from "../../approval/funding";
import type { ReviewedChange } from "../../pricing/types";
import { FundingImpactPreview } from "./FundingImpactPreview";

// The rug's supplier keeps a $60 restocking fee from its refund.
const rugReturn = { key: "change-1", action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000, oldItemFees: [{ kind: "restocking_fee", amountCents: 6_000 }] } as ReviewedChange;
const order = { id: "mixed-order", version: 3, basedOnVersion: 2, contentHash: "frozen-hash", deltaTotalCents: 6_000, changes: [rugReturn] };

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
    blockers: [], notices: ["This preview does not move money.", "Product funding remains subject to vendor confirmation."],
  };
}

function render(value: FundingPlan | null = plan(), props: Partial<Parameters<typeof FundingImpactPreview>[0]> = {}) {
  return renderToStaticMarkup(createElement(FundingImpactPreview, { order, plan: value, status: "awaiting_client_confirmation", canView: true, ...props }));
}

describe("client funding impact preview", () => {
  it("groups every planned step by what happens to the money, with its items and total", () => {
    const html = render();
    expect(html).toContain("What happens to your money if you confirm");
    const step = (title: string) => html.slice(html.indexOf(title), html.indexOf("</li>", html.indexOf(title)));
    expect(step("Held after you confirm")).toContain("$1,100.00");
    expect(step("Held after you confirm")).toContain("1 new hold: New desk $1,100.");
    expect(step("Released right after you confirm")).toContain("Old chair $800.");
    expect(step("Released right after you confirm")).toContain("A release isn&#x27;t a refund");
    expect(step("Refunded once the supplier credits it")).toContain("Wool rug $240 (Restocking fee $60.00, not refunded).");
    // An unchanged line still to be paid is a step of its own, not hidden among the changes.
    expect(step("You pay through PayPal")).toContain("Design services $400.");
    expect(html).toContain("does not query PayPal live");
    expect(html).toMatch(/datetime="2026-10-21T20:00:00Z"/i);
    expect(html).not.toContain("<button");
  });

  it("shows charges and releases that wait for the supplier as waiting for it", () => {
    const value = plan();
    value.actions = [
      { itemId: "chair", side: "baseline", label: "Pendant light", kind: "release_authorization", amountCents: 48_000, timing: "after_vendor_confirmation", reason: "" },
      { itemId: "chair", side: "baseline", label: "Pendant light", kind: "capture", amountCents: 96_000, timing: "after_vendor_confirmation", reason: "" },
    ];
    const html = render(value);
    expect(html).toContain("Released once the supplier confirms");
    expect(html).toContain("Charged from a hold once the supplier confirms");
    expect(html).not.toContain("right after you confirm");
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
    expect(html).not.toContain("Held after you confirm");
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
    expect(html).not.toContain("if you confirm");
  });

  it("labels superseded and requested-adjustment versions without current payment instructions", () => {
    const historical = render(plan(), { status: "superseded" });
    expect(historical).toContain("Historical payment plan");
    expect(historical).toContain("Review the latest client version");
    expect(historical).not.toContain("$1,100.00");
    const declined = render(plan(), { status: "declined" });
    expect(declined).toContain("The designer must issue a new version");
    expect(declined).not.toContain("if you confirm");
  });

  it("makes clear an approved version shows remaining steps from current records", () => {
    const html = render(plan(), { status: "approved" });
    expect(html).toContain("What is left to happen to your money");
    expect(html).toContain("not a snapshot taken at approval");
  });

  it("escapes labels, reasons and blockers instead of executing supplier text", () => {
    const value = plan();
    value.actions[0].label = '<script>alert("item")</script>';
    value.actions[0].reason = '<img src=x onerror="alert(1)">';
    const html = render(value);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
});
