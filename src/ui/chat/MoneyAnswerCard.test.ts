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
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer: snapshot() }));
    expect(html).toContain("not a live PayPal check");
    expect(html).toContain("No recorded PayPal receipt");
    expect(html).toContain("Payment status is unknown.");
    expect(html).toMatch(/datetime="2026-10-21T20:00:00Z"/i);
    expect(html).toContain('href="/quotes/maple"');
  });
  it("does not turn an invalid source URL or source text into executable markup", () => {
    const answer = snapshot();
    answer.sources[0].href = "javascript:alert(1)";
    answer.sources[0].label = '<script>alert("source")</script>';
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("not a live PayPal check");
  });
});
