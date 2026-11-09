import { describe, expect, it } from "vitest";
import { moneyStatus } from "./money-context";
import { amountsIn, buildMoneyAnswer, hasPaymentStatusClaim, hasUnsupportedMoneyClaim, isMoneyQuestion, UNVERIFIED_MONEY_TABLE_TEXT, UNVERIFIED_MONEY_TEXT, verifyMoneyAnswer } from "./money-answer";
import type { MoneyAnswerDraft, MoneyAnswerSentence, MoneyContext } from "./money-types";

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

/** Two café items after V2: the countertop was charged, then partly refunded, and keeps a fee; the pendants were charged and the rest of their hold released. */
function cafe(): MoneyContext {
  return {
    projectKey: "maple", quoteId: "visitor-v2", version: 2, checkedAt: "2026-11-09T19:28:00Z", providerRecordedAt: "2026-11-09T19:26:00Z", mode: "recorded_sandbox",
    sources: [{ id: "quote", kind: "quote", label: "Client-confirmed V2 quote", href: "/quotes/maple", recordedAt: null }],
    facts: [
      { id: "item:baseline:countertop", text: { en: "Quartz countertop (baseline): this version's target is $3,520.00; currently held $0.00, completed captures $3,960.00, completed refunds $440.00, released authorization $0.00, net captured $3,520.00." }, sourceIds: ["quote"] },
      { id: "terms:baseline:countertop", text: { en: "Quartz countertop: the client-confirmed old-item handling is cancelled; the retained old-item cost is $280.00. This amount is already included in the confirmed target and must not be deducted a second time." }, sourceIds: ["quote"] },
      { id: "item:baseline:pendants", text: { en: "Counter pendant light (baseline): this version's target is $960.00; currently held $0.00, completed captures $960.00, completed refunds $0.00, released authorization $480.00, net captured $960.00. A released authorization is not a refund of captured money." }, sourceIds: ["quote"] },
      { id: "scope", text: { en: "For the shown payment items only: held $0.00, completed captures $4,920.00, completed refunds $440.00, released authorization $480.00, net captured $4,480.00." }, sourceIds: ["quote"] },
    ],
    mandatoryFactIds: [],
    items: [
      { key: "baseline:countertop", label: "Quartz countertop", status: "refunded", heldCents: 0, chargedCents: 396_000, refundedCents: 44_000, releasedCents: 0, nonRefundableCents: 28_000, netCents: 352_000, factIds: ["item:baseline:countertop", "terms:baseline:countertop"] },
      { key: "baseline:pendants", label: "Counter pendant light", status: "charged", heldCents: 0, chargedCents: 96_000, refundedCents: 0, releasedCents: 48_000, nonRefundableCents: 0, netCents: 96_000, factIds: ["item:baseline:pendants"] },
    ],
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
  const part = (text: string, factIds: string[], about?: string[]): MoneyAnswerSentence => ({ text, factIds, ...(about ? { about } : {}) });
  const warning = part("There is no recorded payment evidence yet.", ["unknown"]);
  const draft = (summary: MoneyAnswerSentence, notes = [warning], items: string[] = []): MoneyAnswerDraft => ({ summary, items, notes });

  it("reads amounts in the forms people write them", () => {
    expect(amountsIn("$5,670.00, $960 and USD 1,200.5 then 240 USD; -$60 and −$2,060.00")).toEqual([567_000, 96_000, 120_050, 24_000, 6_000, 206_000]);
  });

  it("accepts a summary and notes whose amounts and statuses come from the facts they cite", () => {
    expect(verifyMoneyAnswer(evidence(), draft(part("The budget went down by $60.", ["budget"])))).toEqual([]);
  });

  it("rejects an amount the cited facts do not contain, including totals Setti worked out itself", () => {
    const problems = verifyMoneyAnswer(evidence(), draft(part("The budget changed by $120.", ["budget"])));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("$120.00");
    // The rewrite is told which amounts the records do contain.
    expect(problems[0]).toContain("those records contain $60.00");
  });

  it("rejects amounts or payment statuses stated with nothing to rest on", () => {
    expect(verifyMoneyAnswer(evidence(), draft(part("The budget changed by $60.", []))).join(" ")).toContain("cites no fact");
    expect(verifyMoneyAnswer(evidence(), draft(part("Nothing was refunded.", []))).join(" ")).toContain("cites no fact");
  });

  it("rejects a payment status none of the cited facts records", () => {
    expect(verifyMoneyAnswer(evidence(), draft(part("The budget was refunded.", ["budget"]))).join(" ")).toContain("a refund");
  });

  it("requires recorded warnings to be addressed, and rejects unknown facts, links, other scripts and claimed actions", () => {
    expect(verifyMoneyAnswer(evidence(), draft(part("The budget changed by $60.", ["budget"]), [])).join(" ")).toContain("unknown");
    expect(verifyMoneyAnswer(evidence(), draft(part("See the record.", ["invented"]))).join(" ")).toContain("not in moneyEvidence");
    expect(verifyMoneyAnswer(evidence(), draft(part("See https://evil.example", ["budget"]))).join(" ")).toContain("link");
    expect(verifyMoneyAnswer(evidence(), draft(part("预算", ["budget"]))).join(" ")).toContain("not in English");
    expect(verifyMoneyAnswer(evidence(), draft(part("I refunded the difference.", ["budget"]))).join(" ")).toContain("cannot move money");
  });

  it("checks a sentence about an item against every record of that item, whichever one it cites", () => {
    // The café answer that failed twice: true, but it cited only the countertop's terms, which do not say "charged".
    const kept = part("The countertop keeps $280.00 as a fabrication fee, already included in what is charged.", ["terms:baseline:countertop"], ["baseline:countertop"]);
    expect(verifyMoneyAnswer(cafe(), draft(kept, []))).toEqual([]);
    expect(verifyMoneyAnswer(cafe(), draft({ ...kept, about: [] }, [])).join(" ")).toContain("mentions a charge");
    expect(verifyMoneyAnswer(cafe(), draft(part("$480.00 of the pendant hold was released, not refunded.", [], ["baseline:pendants"]), []))).toEqual([]);
  });

  it("does not let one item's sentence borrow another item's money", () => {
    const problems = verifyMoneyAnswer(cafe(), draft(part("The pendants were refunded $440.00.", [], ["baseline:pendants"]), []));
    expect(problems.join(" ")).toContain("$440.00, which is not written in the records of Counter pendant light");
    // The project's own records hold its totals, not each item's amounts.
    expect(verifyMoneyAnswer(cafe(), draft(part("In all $4,480.00 is charged and $440.00 refunded.", [], ["project"]), []))).toEqual([]);
    expect(verifyMoneyAnswer(cafe(), draft(part("The countertop keeps $280.00.", [], ["project"]), [])).join(" ")).toContain("$280.00");
  });

  it("rejects table items and about keys that are not items of this project, and the same item twice", () => {
    const summary = part("Here is where things stand.", [], ["project"]);
    expect(verifyMoneyAnswer(cafe(), draft(summary, [], ["baseline:countertop", "baseline:pendants"]))).toEqual([]);
    expect(verifyMoneyAnswer(cafe(), draft(summary, [], ["baseline:sofa"])).join(" ")).toContain('"baseline:sofa"');
    expect(verifyMoneyAnswer(cafe(), draft(summary, [], ["baseline:pendants", "baseline:pendants"])).join(" ")).toContain("twice");
    expect(verifyMoneyAnswer(cafe(), draft(part("Nothing is pending.", [], ["baseline:sofa"]), [])).join(" ")).toContain("not in moneyEvidence.items");
  });

  it("saves the table from the records as they are, and a plain-text form for previews", () => {
    const context = cafe();
    const answer = draft(part("In all $4,480.00 is charged and $440.00 refunded.", [], ["project"]), [part("$480.00 of the pendant hold was released, not refunded.", [], ["baseline:pendants"])], ["baseline:countertop", "baseline:pendants"]);
    const result = buildMoneyAnswer(context, ["scope"], answer);
    expect(result.moneyAnswer.table?.map((row) => [row.label, row.status, row.netCents, row.nonRefundableCents])).toEqual([["Quartz countertop", "refunded", 352_000, 28_000], ["Counter pendant light", "charged", 96_000, 0]]);
    expect(result.text).toBe("In all $4,480.00 is charged and $440.00 refunded.\nQuartz countertop: Refunded · net $3,520.00\nCounter pendant light: Charged · net $960.00\n$480.00 of the pendant hold was released, not refunded.");
    expect(result.moneyAnswer.answer).toEqual({ summary: answer.summary, rows: [], notes: answer.notes });
    // Every record of what it is about is kept as evidence; later changes to the records do not rewrite it.
    expect(result.moneyAnswer.facts.map((fact) => fact.id)).toEqual(["scope", "item:baseline:pendants", "item:baseline:countertop", "terms:baseline:countertop"]);
    context.items![0].refundedCents = 0;
    expect(result.moneyAnswer.table?.[0].refundedCents).toBe(44_000);
  });

  it("keeps the table from the records when the written answer is not shown", () => {
    const result = buildMoneyAnswer(cafe(), ["scope"], undefined, false, ["baseline:countertop", "baseline:sofa"]);
    expect(result.text).toBe(UNVERIFIED_MONEY_TABLE_TEXT);
    expect(result.moneyAnswer.table?.map((row) => row.key)).toEqual(["baseline:countertop"]);
    expect(result.moneyAnswer).not.toHaveProperty("answer");
  });
});

describe("an item's status in fixed words", () => {
  const money = (patch: Partial<Parameters<typeof moneyStatus>[0]> = {}) => ({ heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 0, ...patch });
  const none = { pending: false, waitingCredit: false, refundDue: false };

  it("puts anything still uncertain or owed first, then what the money is doing now", () => {
    expect(moneyStatus(money({ capturedCents: 1 }), { ...none, pending: true })).toBe("waiting_for_result");
    expect(moneyStatus(money({ capturedCents: 98_000 }), { ...none, waitingCredit: true })).toBe("waiting_for_supplier_credit");
    expect(moneyStatus(money({ capturedCents: 98_000 }), { ...none, refundDue: true })).toBe("refund_due");
    expect(moneyStatus(money({ heldCents: 1, capturedCents: 1 }), none)).toBe("on_hold");
    expect(moneyStatus(money({ capturedCents: 98_000, refundedCents: 78_400 }), none)).toBe("refunded");
    expect(moneyStatus(money({ capturedCents: 96_000, releasedCents: 48_000 }), none)).toBe("charged");
    expect(moneyStatus(money({ releasedCents: 48_000 }), none)).toBe("released");
    expect(moneyStatus(money(), none)).toBe("not_charged");
  });
});
