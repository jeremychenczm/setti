import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoneyAnswer, MoneyTableRow } from "../../ai/money-types";
import { MoneyAnswerCard } from "./MoneyAnswerCard";

function snapshot(): MoneyAnswer {
  return {
    quoteId: "demo-maple-v1", version: 1, mode: "recorded_sandbox",
    checkedAt: "2026-10-21T20:00:00Z", providerRecordedAt: null,
    facts: [{ id: "missing", text: { en: "Payment status is unknown." }, sourceIds: ["quote"] }],
    sources: [{ id: "quote", kind: "quote", label: "Confirmed quote", href: "/quotes/maple", recordedAt: null }],
  };
}

describe("recorded money evidence card", () => {
  it("keeps snapshot time, no-receipt uncertainty and a clickable local source visible", () => {
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer: snapshot(), messageId: "reply" }));
    expect(html).toContain("Not a live PayPal check");
    expect(html).toContain("no recorded PayPal receipt");
    expect(html).toContain("Payment status is unknown.");
    expect(html).toMatch(/datetime="2026-10-21T20:00:00Z"/i);
    expect(html).toContain('href="/quotes/maple"');
  });
  it("does not turn an invalid source URL or source text into executable markup", () => {
    const answer = snapshot();
    answer.sources[0].href = "javascript:alert(1)";
    answer.sources[0].label = '<script>alert("source")</script>';
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer, messageId: "reply" }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Not a live PayPal check");
  });
  it("shows Setti's answer in its chosen layout without citations, and the records only when Setti shows the evidence", () => {
    const answer = { ...snapshot(), answer: {
      summary: { text: "There is no recorded payment yet.", factIds: ["missing"] },
      rows: [{ label: "Lounge chair", status: "Not charged", amount: "$0.00", factIds: ["missing"] }],
      notes: [{ text: "Approval alone is not a payment.", factIds: ["missing"] }],
    } };
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer, messageId: "reply" }));
    expect(html).toContain("There is no recorded payment yet.");
    expect(html).toMatch(/<td[^>]*>Lounge chair<\/td>/);
    expect(html).toContain("$0.00");
    expect(html).toContain("<li>Approval alone is not a payment.</li>");
    expect(html).not.toContain("[1]");
    expect(html).not.toContain("Payment status is unknown.");
    expect(html).not.toContain('href="/quotes/maple"');
    const shown = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer: { ...answer, showEvidence: true }, messageId: "reply" }));
    expect(shown).toContain("Payment status is unknown.");
    expect(shown).toContain('href="/quotes/maple"');
    expect(shown).toContain('id="money-reply-fact-1"');
  });

  const row = (patch: Partial<MoneyTableRow>): MoneyTableRow => ({ key: "baseline:x", label: "Item", status: "charged", heldCents: 0, chargedCents: 0, refundedCents: 0, releasedCents: 0, nonRefundableCents: 0, netCents: 0, factIds: ["missing"], ...patch });
  const table = [
    row({ key: "baseline:countertop", label: "Quartz countertop", status: "refunded", chargedCents: 396_000, refundedCents: 44_000, nonRefundableCents: 28_000, netCents: 352_000 }),
    row({ key: "baseline:pendants", label: "Counter pendant light", status: "charged", chargedCents: 96_000, releasedCents: 48_000, netCents: 96_000 }),
  ];

  it("shows the item table from the records: what each item paid in the end, with its status and other money in fixed words, and the total", () => {
    const answer: MoneyAnswer = { ...snapshot(), table: [...table, row({ key: "baseline:stool", label: "Counter stool", status: "on_hold", heldCents: 273_000 }), row({ key: "baseline:lamp", label: "Floor lamp", status: "waiting_for_supplier_credit", chargedCents: 30_000, netCents: 30_000 })],
      answer: { summary: { text: "Everything is settled.", factIds: ["missing"] }, rows: [], notes: [] } };
    const text = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer, messageId: "reply" })).replace(/<[^>]+>/g, "");
    expect(text).toContain("Everything is settled.");
    expect(text).toContain("Quartz countertop" + "Charged $3,960.00 · Refunded $440.00 · Non-refundable $280.00" + "$3,520.00");
    expect(text).toContain("Counter pendant light" + "Charged $960.00 · Released $480.00" + "$960.00");
    expect(text).toContain("Counter stool" + "On hold $2,730.00" + "$0.00");
    expect(text).toContain("Floor lamp" + "Waiting for supplier credit" + "$300.00");
    expect(text).toContain("Total" + "On hold $2,730.00 · Charged $5,220.00 · Refunded $440.00 · Released $480.00 · Non-refundable $280.00" + "$4,780.00");
    expect(text).toContain("From the PayPal Sandbox records");
    expect(text).not.toContain("Payment status is unknown.");
  });

  it("keeps the table, with the records behind it, when there is no written answer", () => {
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer: { ...snapshot(), table }, messageId: "reply" }));
    expect(html).toContain("Quartz countertop");
    expect(html).toContain("<summary");
    expect(html).toContain("Payment status is unknown.");
  });
});
