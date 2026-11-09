import { describe, expect, it } from "vitest";
import { amountsIn, buildMoneyAnswer, hasPaymentStatusClaim, hasUnsupportedMoneyClaim, isMoneyQuestion, UNVERIFIED_MONEY_TEXT, verifyMoneyAnswer } from "./money-answer";
import type { MoneyAnswerRow, MoneyContext } from "./money-types";

function evidence(): MoneyContext {
  return {
    projectKey: "maple", quoteId: "demo-maple-v1", version: 1, checkedAt: "2026-10-21T20:00:00Z", providerRecordedAt: null, mode: "recorded_sandbox",
    sources: [{ id: "quote", kind: "quote", label: "Approved quote", href: "/quotes/maple", recordedAt: null }],
    facts: [
      { id: "budget", text: { en: "Budget changed by $60." }, sourceIds: ["quote"] },
      { id: "unknown", text: { en: "No recorded payment evidence." }, sourceIds: ["quote"] },
    ], mandatoryFactIds: ["unknown"],
  };
}

describe("recorded money answers", () => {
  it("renders only server facts, always retains uncertainty, and snapshots their evidence", () => {
    const context = evidence();
    const result = buildMoneyAnswer(context, ["budget"]);
    expect(result.moneyAnswer.facts.map((f) => f.id)).toEqual(["budget", "unknown"]);
    expect(result.moneyAnswer.sources).toEqual(context.sources);
    // Without a written answer the facts stand alone, under a notice that says so.
    expect(result.text).toBe(UNVERIFIED_MONEY_TEXT);
    expect(result.moneyAnswer).not.toHaveProperty("answer");
    context.facts[0].text.en = "Changed later";
    context.sources[0].label = "Changed later";
    expect(result.moneyAnswer.facts[0].text.en).toBe("Budget changed by $60.");
    expect(result.moneyAnswer.sources[0].label).toBe("Approved quote");
  });
  it.each([{ ids: [] }, { ids: ["foreign"] }, { ids: ["budget", "budget"] }])("rejects invalid fact selection $ids", ({ ids }) => {
    expect(() => buildMoneyAnswer(evidence(), ids)).toThrow();
  });
  it("rejects invented citations and external source links", () => {
    const context = evidence();
    context.facts[0].sourceIds = ["fake"];
    expect(() => buildMoneyAnswer(context, ["budget"])).toThrow();
    context.facts[0].sourceIds = ["quote"];
    context.sources[0].href = "https://evil.example/pay";
    expect(() => buildMoneyAnswer(context, ["budget"])).toThrow();
  });
  it.each(["@Setti Why was the desk charged when the rug is not refunded yet?", "@Setti Explain the holds and refunds.", "@Setti Where is my money?", "@Setti Check this budget and payment status", "@Setti Why did we replace the chair and pay more?", "@Setti Please explain why replacing the chair cost more."])('recognizes a read-only money question: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(true);
  });
  it.each(["@Setti Change the dining chairs from four to six, keep the rest.", "@Setti Return the rug and replace the chair with a desk.", "@Setti Return the rug, make it two desks", "@Setti, change the dining chairs from four to six and show how much it costs.", "@Setti Can you replace the chair and show the cost?", "@Setti Could you please replace the chair and show the cost?", "@Setti Please replace the chair and show the cost."])('keeps natural change requests on the draft path: %s', (text) => {
    expect(isMoneyQuestion(text)).toBe(false);
  });
  it.each(["You already paid $999.", "The refund completed.", "The authorization result is unknown.", "The rug has not been refunded.", "The desk is not paid.", "Payment has not been received.", "\u9000\u6b3e\u5b8c\u6210\u3002"])("blocks unsupported payment prose: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(true);
  });
  it.each(["Which item or payment should I check?", "Do you mean the quote or the payment?"])("allows procedural clarification without a payment-status assertion: %s", (text) => {
    expect(hasUnsupportedMoneyClaim(text)).toBe(false);
  });
  it.each(["Your balance is settled.", "The payment was settled yesterday.", "Everything is settled up.", "The deposit is still unsettled.", "It was settled in full."])("treats settled as a payment word next to money: %s", (text) => {
    expect(hasPaymentStatusClaim(text)).toBe(true);
  });
  it.each(["I drafted the four settled changes: eight dining chairs and no bedroom rug.", "These are the changes we settled in this thread.", "The side tables are not settled yet; the client is still deciding."])("reads settled as decided when no money word is near: %s", (text) => {
    expect(hasPaymentStatusClaim(text)).toBe(false);
  });
});

describe("verifying Setti's written money answer", () => {
  const part = (text: string, factIds: string[]) => ({ text, factIds });
  const warning = part("There is no recorded payment evidence yet.", ["unknown"]);
  const body = (summary: { text: string; factIds: string[] }, notes = [warning], rows: MoneyAnswerRow[] = []) => ({ summary, rows, notes });
  const row = (label: string, status: string, amount: string | null, factIds: string[]): MoneyAnswerRow => ({ label, status, amount, factIds });

  it("reads amounts in the forms people write them", () => {
    expect(amountsIn("$5,670.00, $960 and USD 1,200.5 then 240 USD; -$60 and \u2212$2,060.00")).toEqual([567_000, 96_000, 120_050, 24_000, 6_000, 206_000]);
  });

  it("accepts a summary, rows and notes whose amounts and statuses come from the facts they cite", () => {
    expect(verifyMoneyAnswer(evidence(), body(part("The budget went down by $60.", ["budget"])))).toEqual([]);
    expect(verifyMoneyAnswer(evidence(), body(part("Here is where things stand.", []), [warning], [row("Budget", "Changed", "$60.00", ["budget"])]))).toEqual([]);
  });

  it("rejects an amount the cited facts do not contain, including totals Setti worked out itself", () => {
    const problems = verifyMoneyAnswer(evidence(), body(part("The budget changed by $120.", ["budget"])));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("$120.00");
    expect(verifyMoneyAnswer(evidence(), body(part("Here is the budget.", []), [warning], [row("Budget", "Changed", "$120.00", ["budget"])])).join(" ")).toContain("Row 1");
  });

  it("rejects amounts or payment statuses stated without citing a fact, and rows without citations or with several amounts", () => {
    expect(verifyMoneyAnswer(evidence(), body(part("The budget changed by $60.", []))).join(" ")).toContain("without citing");
    expect(verifyMoneyAnswer(evidence(), body(part("Nothing was refunded.", []))).join(" ")).toContain("without citing");
    expect(verifyMoneyAnswer(evidence(), body(part("Here it is.", []), [warning], [row("Budget", "Changed", null, [])])).join(" ")).toContain("must cite");
    expect(verifyMoneyAnswer(evidence(), body(part("Here it is.", []), [warning], [row("Budget", "Changed", "$60.00 or $60", ["budget"])])).join(" ")).toContain("one amount");
  });

  it("rejects a payment status none of the cited facts records", () => {
    expect(verifyMoneyAnswer(evidence(), body(part("The budget was refunded.", ["budget"]))).join(" ")).toContain("a refund");
  });

  it("requires recorded warnings to be addressed, and rejects unknown facts, links, other scripts and claimed actions", () => {
    expect(verifyMoneyAnswer(evidence(), body(part("The budget changed by $60.", ["budget"]), [])).join(" ")).toContain("unknown");
    expect(verifyMoneyAnswer(evidence(), body(part("See the record.", ["invented"]))).join(" ")).toContain("not in moneyEvidence");
    expect(verifyMoneyAnswer(evidence(), body(part("See https://evil.example", ["budget"]))).join(" ")).toContain("link");
    expect(verifyMoneyAnswer(evidence(), body(part("\u9884\u7b97", ["budget"]))).join(" ")).toContain("not in English");
    expect(verifyMoneyAnswer(evidence(), body(part("I refunded the difference.", ["budget"]))).join(" ")).toContain("cannot move money");
  });

  it("stores the written answer with the facts it cites first, and a plain-text form for previews", () => {
    const answer = body(part("The budget changed by $60.", ["budget"]), [warning], [row("Budget", "Changed", "$60.00", ["budget"])]);
    const result = buildMoneyAnswer(evidence(), ["budget"], answer);
    expect(result.text).toBe("The budget changed by $60." + "\n" + "Budget: Changed · $60.00" + "\n" + "There is no recorded payment evidence yet.");
    expect(result.moneyAnswer.facts.map((fact) => fact.id)).toEqual(["budget", "unknown"]);
    expect(result.moneyAnswer.answer).toEqual(answer);
  });
});
