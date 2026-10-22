import type { ApprovedQuoteReport } from "./types";

/** Exact canonical snapshot tag; order hashes separately use SHA-256. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = value as Record<string, unknown>;
    return `{${Object.keys(entries).filter((key) => entries[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(entries[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function quoteFingerprint(quote: ApprovedQuoteReport): string {
  return canonical(quote);
}
