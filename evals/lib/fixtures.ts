/** Builders for eval fixtures: approved quotes, chat messages and supplier pages, all fictional. */
import type { ApprovedQuoteLine, ApprovedQuoteReport, QuoteCategory } from "@/quotes/types";
import type { CaseMessage, ProductOption, ProductPage } from "@/chat/types";

export const APPROVED_AT = "2026-10-20T17:00:00.000Z";

export interface LineSpec {
  itemId: string;
  name: string;
  room: string;
  vendor: string;
  sku: string;
  specification: string;
  quantity: number;
  unitPriceCents: number;
  unitLabel?: string;
  category?: QuoteCategory;
  freightCents?: number;
  leadTimeDays?: number | null;
  customMade?: boolean;
  nonReturnable?: boolean | null;
  returnPolicy?: string;
  quoteNumber?: string;
}

const SERVICE_TERMS = "Studio service terms: hours are estimates; work already completed is billed if the scope is cancelled.";
const GOODS_TERMS = "Fictional supplier terms: unused items in original packaging may be returned within 30 days of delivery. No restocking fee has been confirmed; check eligibility before promising a refund.";

export function line(spec: LineSpec, signer: string): ApprovedQuoteLine {
  const category = spec.category ?? "furniture";
  const subtotal = spec.quantity * spec.unitPriceCents;
  const quoteNumber = spec.quoteNumber ?? `${spec.sku.split("-")[0]}-Q-1027`;
  return {
    itemId: spec.itemId, name: spec.name, vendor: spec.vendor, category, room: spec.room, sku: spec.sku,
    specification: spec.specification, quantity: spec.quantity, unitLabel: spec.unitLabel ?? (category === "service" ? "hour" : "each"),
    unitPriceCents: spec.unitPriceCents,
    taxCents: category === "service" ? 0 : Math.round((subtotal * 875) / 10_000),
    freightCents: spec.freightCents ?? 0,
    source: category === "service"
      ? { kind: "estimate", reference: spec.sku, name: "Studio service estimate", note: "Fictional studio estimate for an eval case." }
      : { kind: "demo", reference: `${quoteNumber} · ${spec.sku}`, name: `${spec.vendor.replace(" (demo)", "")} quote ${quoteNumber}`, note: "Fictional supplier quote used as eval data; the supplier, product and price are invented.", checkedAt: "2026-10-18" },
    leadTimeDays: spec.leadTimeDays ?? null,
    returnPolicy: spec.returnPolicy ?? (category === "service" ? SERVICE_TERMS : GOODS_TERMS),
    restockingFeeBps: null,
    customMade: spec.customMade ?? false,
    nonReturnable: spec.nonReturnable ?? null,
    approval: { status: "approved", approvedBy: signer, approvedAt: APPROVED_AT, signature: signer, isDemo: true },
  };
}

export interface QuoteSpec {
  id: string;
  projectId: string;
  projectName: string;
  clientName: string;
  rooms: string;
  lines: LineSpec[];
}

export function approvedQuote(spec: QuoteSpec): ApprovedQuoteReport {
  return {
    id: spec.id, version: 1, projectId: spec.projectId, projectName: spec.projectName, room: spec.rooms,
    clientName: `${spec.clientName} (demo client)`, designerName: "Jordan Lee (demo designer)", currency: "USD",
    status: "approved", approvedAt: APPROVED_AT, approvedBy: spec.clientName, signature: spec.clientName, isDemo: true,
    demoNotice: "Fictional eval quote: the household, suppliers, products and prices are invented.",
    paymentNote: "This quote confirms no payment. No PayPal authorization, charge or refund is represented.",
    assumptions: [
      "Merchandise tax is a test assumption of 8.75% per line; services carry no tax.",
      "Finish materials are supply only; installation is by the client's contractor.",
    ],
    lines: spec.lines.map((entry) => line(entry, spec.clientName)),
  };
}

/** Messages a few minutes apart, starting the day after V1 was approved. */
export function conversation(entries: readonly (readonly [id: string, actor: CaseMessage["actor"], text: string])[]): CaseMessage[] {
  const start = Date.parse("2026-10-21T15:00:00.000Z");
  return entries.map(([id, actor, text], index) => ({
    id, actor, text, createdAt: new Date(start + index * 7 * 60_000).toISOString(),
    replyToMessageId: null, aiState: actor === "assistant" ? "completed" : "none", error: null, model: actor === "assistant" ? "claude-sonnet-5-5" : null,
  }));
}

export function option(spec: Omit<ProductOption, "brand" | "currency" | "priceEvidence" | "availability"> & { availability?: string }): ProductOption {
  return {
    ...spec, brand: null, currency: "USD", availability: spec.availability ?? "In stock",
    priceEvidence: spec.unitPriceCents === null ? null : JSON.stringify({ listed: spec.unitPriceCents / 100, unit: spec.unitLabel, sku: spec.sku }),
  };
}

export function page(url: string, title: string, text: string, products: ProductOption[]): ProductPage {
  return { id: `page-${url.replace(/[^a-z0-9]+/giu, "-").slice(-40)}`, url, fetchedAt: "2026-10-21T15:30:00.000Z", title, text, products, error: null };
}
