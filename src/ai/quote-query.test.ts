import { describe, expect, it } from "vitest";
import { HOME_APPROVED_QUOTE } from "@/demo/living-dining";
import type { ApprovedQuoteReport } from "@/quotes/types";
import { describeQuoteQuery, quoteMessageProblems, quoteQueryProblems, runQuoteQuery, type QuoteQuery } from "./quote-query";

const query = (filters: QuoteQuery["filters"], sort: QuoteQuery["sort"] = null, limit: number | null = null): QuoteQuery => ({ filters, sort, limit });
const names = (answer: ReturnType<typeof runQuoteQuery>) => answer.rows.map((row) => row.itemId);

describe("running a quote query on the approved quote", () => {
  it("lists every line whose total is over an amount, counting quantity", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "lineTotal", op: "gt", value: "1000" }], { field: "lineTotal", direction: "desc" }));
    // Six dining chairs at $180 each come to $1,080, so they count; design services at exactly $1,000 do not.
    expect(names(answer)).toEqual(["sofa", "dining-table", "sideboard", "dining-chairs"]);
    expect(answer).toMatchObject({ quoteId: HOME_APPROVED_QUOTE.id, version: 1, matchedCount: 4, totalCents: 240_000 + 140_000 + 120_000 + 108_000 });
  });

  it("reads a unit price differently from a line total", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "unitPrice", op: "gte", value: "$1,000" }]));
    expect(names(answer)).toEqual(["design", "sofa", "dining-table", "sideboard"]);
  });

  it("includes each line's tax and delivery in its total", () => {
    const quote: ApprovedQuoteReport = { ...HOME_APPROVED_QUOTE, lines: HOME_APPROVED_QUOTE.lines.map((line) => line.itemId === "coffee-table" ? { ...line, taxCents: 5_000, freightCents: 4_000 } : line) };
    const [row] = runQuoteQuery(quote, query([{ field: "name", op: "contains", value: "coffee" }])).rows;
    expect(row).toMatchObject({ unitPriceCents: 65_000, lineTotalCents: 74_000, supplier: "Orbit Workshop" });
  });

  it("finds the most expensive furniture line with a sort and a limit, and still counts every match", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "category", op: "eq", value: "Furniture" }], { field: "lineTotal", direction: "desc" }, 1));
    expect(names(answer)).toEqual(["sofa"]);
    expect(answer).toMatchObject({ matchedCount: 5, totalCents: 240_000 });
  });

  it("matches text without regard to case and keeps the quote's order when unsorted", () => {
    expect(names(runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "name", op: "contains", value: "DINING" }])))).toEqual(["dining-table", "dining-chairs", "sideboard"]);
    expect(names(runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "quantity", op: "gt", value: "1" }])))).toEqual(["dining-chairs"]);
  });

  it("returns no rows rather than guessing when nothing matches", () => {
    expect(runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "supplier", op: "eq", value: "Nowhere Ltd" }]))).toMatchObject({ rows: [], matchedCount: 0, totalCents: 0 });
  });
});

describe("checking a query before it runs", () => {
  it.each([
    [{ field: "name", op: "gt", value: "sofa" }, /text fields take only eq or contains/],
    [{ field: "lineTotal", op: "contains", value: "1000" }, /takes gt, gte, lt, lte or eq/],
    [{ field: "lineTotal", op: "gt", value: "a thousand" }, /dollar amount/],
    [{ field: "quantity", op: "gt", value: "1.5" }, /whole number/],
  ] as const)("refuses %o", (filter, problem) => {
    const checked = query([filter]);
    expect(quoteQueryProblems(checked).join(" ")).toMatch(problem);
    expect(() => runQuoteQuery(HOME_APPROVED_QUOTE, checked)).toThrow(/not been checked/);
  });
});

describe("describing a query in plain words", () => {
  it("says which measure, amount, order and limit were used", () => {
    expect(describeQuoteQuery(query([{ field: "lineTotal", op: "gt", value: "1000" }, { field: "room", op: "eq", value: " Living & dining room " }], { field: "lineTotal", direction: "desc" }, 1)))
      .toEqual(["Line total over $1,000.00", "Room is “Living & dining room”", "Highest line total first", "Top line only"]);
    expect(describeQuoteQuery(query([]))).toEqual(["Every line"]);
  });
});

describe("checking the sentence written before the results", () => {
  const overThousand = query([{ field: "lineTotal", op: "gt", value: "1000" }]);
  it("may repeat the amount the question asked about", () => {
    expect(quoteMessageProblems("Here are the lines in V1 whose total, including tax and delivery, is over $1,000.", overThousand)).toEqual([]);
  });
  it("may not state a result amount, a payment result or another language", () => {
    expect(quoteMessageProblems("The sofa is the largest line at $2,400.", overThousand).join(" ")).toMatch(/only the amounts in quoteQuery/);
    expect(quoteMessageProblems("These lines over $1,000 were already charged.", overThousand).join(" ")).toMatch(/money mode/);
    expect(quoteMessageProblems("超过 $1,000 的项目如下。", overThousand).join(" ")).toMatch(/English/);
  });
});
