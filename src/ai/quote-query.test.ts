import { describe, expect, it } from "vitest";
import { HOME_APPROVED_QUOTE } from "@/demo/living-dining";
import type { ApprovedQuoteReport } from "@/quotes/types";
import { describeQuoteQuery, quoteMessageProblems, quoteQueryProblems, runQuoteQuery, type QuoteQuery } from "./quote-query";

const query = (filters: QuoteQuery["filters"], sort: QuoteQuery["sort"] = null, limit: number | null = null): QuoteQuery => ({ filters, sort, limit });
const names = (answer: ReturnType<typeof runQuoteQuery>) => answer.rows.map((row) => row.itemId);

describe("running a quote query on the approved quote", () => {
  it("lists every line whose total is over an amount, counting quantity", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "lineTotal", op: "gt", value: "1000" }], { field: "lineTotal", direction: "desc" }));
    // Eight stools at $195 each come to $1,560 and 22 feet of countertop at $180 to $3,960, so both
    // count; 14 boxes of tile at $70 ($980) and four $180 site visits ($720) do not.
    expect(names(answer)).toEqual(["countertop", "design", "stools", "pendants"]);
    expect(answer).toMatchObject({ quoteId: HOME_APPROVED_QUOTE.id, version: 1, matchedCount: 4, totalCents: 396_000 + 240_000 + 156_000 + 144_000 });
  });

  it("reads a unit price differently from a line total", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "unitPrice", op: "gte", value: "$1,000" }]));
    // Only the fixed design fee has a unit price of $1,000 or more; the countertop's line total is high, its per-foot price is not.
    expect(names(answer)).toEqual(["design"]);
  });

  it("includes each line's tax and delivery in its total", () => {
    const quote: ApprovedQuoteReport = { ...HOME_APPROVED_QUOTE, lines: HOME_APPROVED_QUOTE.lines.map((line) => line.itemId === "pendants" ? { ...line, taxCents: 5_000, freightCents: 4_000 } : line) };
    const [row] = runQuoteQuery(quote, query([{ field: "name", op: "contains", value: "pendant" }])).rows;
    expect(row).toMatchObject({ unitPriceCents: 24_000, lineTotalCents: 153_000, supplier: "Lumen Row Lighting" });
  });

  it("finds the most expensive furniture line with a sort and a limit, and still counts every match", () => {
    const answer = runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "category", op: "eq", value: "Furniture" }], { field: "lineTotal", direction: "desc" }, 1));
    expect(names(answer)).toEqual(["countertop"]);
    expect(answer).toMatchObject({ matchedCount: 6, totalCents: 396_000 });
  });

  it("matches text without regard to case and keeps the quote's order when unsorted", () => {
    expect(names(runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "name", op: "contains", value: "COUNTER" }])))).toEqual(["electrical", "countertop", "pendants", "stools"]);
    expect(names(runQuoteQuery(HOME_APPROVED_QUOTE, query([{ field: "quantity", op: "gt", value: "1" }])))).toEqual(["site-visits", "countertop", "wall-tile", "shelving", "pendants", "stools"]);
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
