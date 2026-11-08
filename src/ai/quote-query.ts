/**
 * Looking things up in the approved quote. The model only turns a question
 * into a query over a fixed set of fields; the server runs it on the quote's
 * own lines, so every listed line and amount comes from the quote and no
 * matching line is left out.
 */
import { z } from "zod";
import { calculateLineTotals } from "@/quotes/totals";
import type { ApprovedQuoteReport } from "@/quotes/types";
import { amountsIn, hasEastAsianScript, hasPaymentStatusClaim } from "./money-answer";

const TEXT_FIELDS = ["name", "room", "category", "supplier"] as const;
const NUMBER_FIELDS = ["unitPrice", "quantity", "lineTotal"] as const;
const MONEY_FIELDS: readonly QuoteNumberField[] = ["unitPrice", "lineTotal"];
type QuoteTextField = (typeof TEXT_FIELDS)[number];
type QuoteNumberField = (typeof NUMBER_FIELDS)[number];
const TEXT_OPS = ["eq", "contains"] as const;
const NUMBER_OPS = ["gt", "gte", "lt", "lte", "eq"] as const;

export const quoteQuerySchema = z.strictObject({
  filters: z.array(z.strictObject({
    field: z.enum([...TEXT_FIELDS, ...NUMBER_FIELDS]),
    op: z.enum(["eq", "contains", "gt", "gte", "lt", "lte"]),
    /** Text to match, a dollar amount such as "1000", or a whole quantity. */
    value: z.string().min(1).max(120),
  })).max(6),
  sort: z.strictObject({ field: z.enum(["name", ...NUMBER_FIELDS]), direction: z.enum(["asc", "desc"]) }).nullable(),
  limit: z.number().int().min(1).max(100).nullable(),
});
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;

/** One quote line as the lookup shows it. */
export interface QuoteAnswerRow {
  itemId: string;
  name: string;
  room: string;
  category: ApprovedQuoteReport["lines"][number]["category"];
  supplier: string;
  quantity: number;
  unitLabel: string;
  unitPriceCents: number;
  /** Quantity times unit price, plus the line's tax and delivery. */
  lineTotalCents: number;
}

/** Stored with the reply, so a later version of the quote cannot change an earlier answer. */
export interface QuoteAnswer {
  quoteId: string;
  version: number;
  checkedAt: string;
  query: QuoteQuery;
  rows: QuoteAnswerRow[];
  /** Lines that matched before the limit; rows may show fewer. */
  matchedCount: number;
  /** The shown rows' line totals added up. */
  totalCents: number;
}

const isTextField = (field: string): field is QuoteTextField => (TEXT_FIELDS as readonly string[]).includes(field);

/** "1000", "1,000", "$1,000.50" → cents; null when it is not a plain non-negative amount. */
function parseCents(value: string): number | null {
  const match = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/u.exec(value);
  if (!match) return null;
  const cents = Number(match[1].replaceAll(",", "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseQuantity(value: string): number | null {
  return /^\s*\d+\s*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function numberValue(field: QuoteNumberField, value: string): number | null {
  return field === "quantity" ? parseQuantity(value) : parseCents(value);
}

/** What the model must fix before the query can run: each field takes only its own operators and values. */
export function quoteQueryProblems(query: QuoteQuery): string[] {
  const problems: string[] = [];
  query.filters.forEach(({ field, op, value }, index) => {
    const label = `Filter ${index + 1} (${field} ${op} "${value}")`;
    if (isTextField(field)) {
      if (!(TEXT_OPS as readonly string[]).includes(op)) problems.push(`${label}: text fields take only eq or contains.`);
      return;
    }
    if (!(NUMBER_OPS as readonly string[]).includes(op)) problems.push(`${label}: ${field} takes gt, gte, lt, lte or eq.`);
    if (numberValue(field, value) === null) problems.push(`${label}: write ${field === "quantity" ? "a whole number" : "a dollar amount such as 1000 or 1,250.50"}.`);
  });
  return problems;
}

function row(line: ApprovedQuoteReport["lines"][number]): QuoteAnswerRow {
  return {
    itemId: line.itemId, name: line.name, room: line.room, category: line.category, supplier: line.vendor.replace(/ \(demo\)$/u, ""),
    quantity: line.quantity, unitLabel: line.unitLabel ?? "each", unitPriceCents: line.unitPriceCents, lineTotalCents: calculateLineTotals(line).totalCents,
  };
}

function textOf(entry: QuoteAnswerRow, field: QuoteTextField): string {
  return field === "supplier" ? entry.supplier : entry[field];
}

function numberOf(entry: QuoteAnswerRow, field: QuoteNumberField): number {
  return field === "quantity" ? entry.quantity : field === "unitPrice" ? entry.unitPriceCents : entry.lineTotalCents;
}

function matches(entry: QuoteAnswerRow, filter: QuoteQuery["filters"][number]): boolean {
  if (isTextField(filter.field)) {
    const actual = textOf(entry, filter.field).trim().toLowerCase(), wanted = filter.value.trim().toLowerCase();
    return filter.op === "eq" ? actual === wanted : actual.includes(wanted);
  }
  const actual = numberOf(entry, filter.field), wanted = numberValue(filter.field, filter.value)!;
  switch (filter.op) {
    case "gt": return actual > wanted;
    case "gte": return actual >= wanted;
    case "lt": return actual < wanted;
    case "lte": return actual <= wanted;
    default: return actual === wanted;
  }
}

/** Runs a checked query on the quote's lines. Call quoteQueryProblems first. */
export function runQuoteQuery(quote: ApprovedQuoteReport, query: QuoteQuery, now = new Date()): QuoteAnswer {
  if (quoteQueryProblems(query).length) throw new Error("The quote query has not been checked");
  const matched = quote.lines.map(row).filter((entry) => query.filters.every((filter) => matches(entry, filter)));
  const sort = query.sort;
  if (sort) {
    const sign = sort.direction === "asc" ? 1 : -1;
    matched.sort((a, b) => sign * (sort.field === "name" ? a.name.localeCompare(b.name) : numberOf(a, sort.field) - numberOf(b, sort.field)));
  }
  const rows = query.limit ? matched.slice(0, query.limit) : matched;
  return {
    quoteId: quote.id, version: quote.version, checkedAt: now.toISOString(), query: structuredClone(query),
    rows, matchedCount: matched.length, totalCents: rows.reduce((total, entry) => total + entry.lineTotalCents, 0),
  };
}

const FIELD_LABELS: Record<QuoteTextField | QuoteNumberField, string> = {
  name: "Name", room: "Room", category: "Category", supplier: "Supplier", unitPrice: "Unit price", quantity: "Quantity", lineTotal: "Line total",
};
const OP_LABELS = { eq: "is", contains: "contains", gt: "over", gte: "at least", lt: "under", lte: "at most" } as const;
const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** The query in plain words, written by the server, so the reader sees exactly what was looked up. */
export function describeQuoteQuery(query: QuoteQuery): string[] {
  const parts = query.filters.map(({ field, op, value }) => {
    const shown = isTextField(field) ? `“${value.trim()}”` : field === "quantity" ? value.trim() : dollars(parseCents(value)!);
    return `${FIELD_LABELS[field]} ${OP_LABELS[op]} ${shown}`;
  });
  if (query.sort) {
    const { field, direction } = query.sort;
    parts.push(field === "name" ? (direction === "asc" ? "A to Z by name" : "Z to A by name") : `${direction === "desc" ? "Highest" : "Lowest"} ${FIELD_LABELS[field].toLowerCase()} first`);
  }
  if (query.limit) parts.push(query.limit === 1 ? "Top line only" : `First ${query.limit} lines`);
  return parts.length ? parts : ["Every line"];
}

/**
 * The model writes its one sentence before the server runs the query, so the
 * sentence may only repeat the amounts it asked about, never a result.
 */
export function quoteMessageProblems(message: string, query: QuoteQuery): string[] {
  const problems: string[] = [];
  if (hasEastAsianScript(message)) problems.push("Write the message in English.");
  if (hasPaymentStatusClaim(message)) problems.push("A quote lookup cannot say what was paid, held, charged or refunded; questions about payments use money mode.");
  const asked = new Set(query.filters.filter((filter) => (MONEY_FIELDS as readonly string[]).includes(filter.field)).map((filter) => parseCents(filter.value)));
  const unknown = amountsIn(message).filter((amount) => !asked.has(amount));
  if (unknown.length) problems.push("The message may repeat only the amounts in quoteQuery; the server lists the matching lines and their amounts under it.");
  return problems;
}
