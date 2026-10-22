import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MoneyAnswer } from "../../ai/money-types";
import { MoneyAnswerCard } from "./MoneyAnswerCard";

function snapshot(): MoneyAnswer {
  return {
    quoteId: "demo-maple-v1", version: 1, mode: "recorded_sandbox",
    checkedAt: "2026-10-21T20:00:00Z", providerRecordedAt: null,
    facts: [{ id: "missing", text: { en: "Payment status is unknown.", zh: "付款状态未知。" }, sourceIds: ["quote"] }],
    sources: [{ id: "quote", kind: "quote", label: "Confirmed quote", href: "/quotes/maple", recordedAt: null }],
  };
}

describe("recorded money evidence card", () => {
  it("keeps snapshot time, no-receipt uncertainty and a clickable local source visible", () => {
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer: snapshot(), chinese: true }));
    expect(html).toContain("未实时查询 PayPal");
    expect(html).toContain("没有已记录的 PayPal 回执");
    expect(html).toContain("付款状态未知");
    expect(html).toMatch(/datetime="2026-10-21T20:00:00Z"/i);
    expect(html).toContain('href="/quotes/maple"');
  });
  it("does not turn an invalid source URL or source text into executable markup", () => {
    const answer = snapshot();
    answer.sources[0].href = "javascript:alert(1)";
    answer.sources[0].label = '<script>alert("source")</script>';
    const html = renderToStaticMarkup(createElement(MoneyAnswerCard, { answer, chinese: false }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("not a live PayPal check");
  });
});
