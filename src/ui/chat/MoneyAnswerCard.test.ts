import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoneyAnswer } from "../../ai/money-types";
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
});
