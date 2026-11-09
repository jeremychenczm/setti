/** Local fictional supplier documents, never an uploaded file or a live supplier feed. */
import type { DraftChange, ProductOption, ProductPage } from "@/chat/types";
import type { PricingChangeInput, PricingItem } from "@/pricing/types";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import { HOME_APPROVED_QUOTE, HOME_ITEM_IDS, HOME_SUPPLIER_NOTES } from "./living-dining";

export const HOME_EVIDENCE_ID = "maple-cafe-supplier-notes-v1";
export const HOME_PRODUCT_IDS = {
  "wall-tile": "maple-cafe:sage-tile",
  windowCounter: "maple-cafe:oak-window-counter",
  panels: "maple-cafe:felt-panel",
} as const;

export function isHomeQuote(quote: Pick<QuoteDocument, "projectId" | "lines">): boolean {
  return quote.projectId === "maple" && quote.lines.some((line) => (HOME_ITEM_IDS as readonly string[]).includes(line.itemId));
}

/** Products the documents offer: a replacement for one V1 line (itemId), or a new line (itemId null). */
const definitions = [
  { itemId: "wall-tile", id: HOME_PRODUCT_IDS["wall-tile"], name: "Back bar wall tile, sage green", vendor: "Glaze & Co. Tile (demo)", sku: "DEMO-CAFE-TILE-SGE-4", specification: "4 × 4 in ceramic tile, sage green glaze; one box covers 10 sq ft", price: 7_600, unit: "box", lead: 10, reference: "MAPLE-CAFE-TILE-01",
    terms: { returnPolicy: "Local fictional supplier terms: unopened boxes can be returned within 30 days of delivery with prior approval, retaining 20% of the returned goods price.", returnable: true, restockingFeeBps: 2_000, customMade: false } },
  { itemId: null, id: HOME_PRODUCT_IDS.windowCounter, name: "Oak window counter", vendor: "Birch Line Joinery (demo)", sku: "DEMO-CAFE-OAK-WIN-36", specification: "Solid oak window counter, 16 in deep, oiled, on black steel brackets; built for a 36 in counter height; made to measure", price: 21_000, unit: "linear ft", lead: 21, reference: "MAPLE-CAFE-JOINERY-01",
    terms: { returnPolicy: "Local fictional supplier terms: made to order; once production starts the counter cannot be cancelled or returned.", returnable: false, restockingFeeBps: null, customMade: true } },
  { itemId: null, id: HOME_PRODUCT_IDS.panels, name: "Acoustic ceiling panel", vendor: "Quiet Panel Co. (demo)", sku: "DEMO-CAFE-FELT-24", specification: "2 × 4 ft ceiling-hung felt acoustic panel, charcoal", price: 14_500, unit: "each", lead: 14, reference: "MAPLE-CAFE-ACOUSTIC-01",
    terms: { returnPolicy: "Local fictional supplier terms: unused panels can be returned within 14 days of delivery with prior approval, retaining 10% of the goods price.", returnable: true, restockingFeeBps: 1_000, customMade: false } },
] as const;
type Definition = (typeof definitions)[number];

const usd = (cents: number) => `USD ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

function product(definition: Definition): ProductOption {
  return {
    id: definition.id, name: definition.name, sku: definition.sku, brand: null, seller: definition.vendor,
    specification: definition.specification, currency: "USD", unitPriceCents: definition.price, unitLabel: definition.unit,
    priceEvidence: `Local fictional supplier document ${definition.reference}: ${definition.sku}; ${usd(definition.price)} per ${definition.unit}. Whole-line tax USD 0 and delivery USD 0. Source: HOME_SUPPLIER_NOTES, included in this demo, not an uploaded or verified supplier file.`,
    availability: "Sample lead time only; actual stock and accepted orders require a separate supplier confirmation.",
  };
}

export function HOME_EVIDENCE_PAGE(now = new Date().toISOString()): ProductPage {
  return {
    id: HOME_EVIDENCE_ID, url: `local:${HOME_EVIDENCE_ID}`, fetchedAt: now,
    title: "Local fictional supplier documents · Maple Ave Café", text: HOME_SUPPLIER_NOTES,
    products: definitions.map(product), error: null,
  };
}

/** Product selection must refer to this item's own replacement, or to a new line, not another quoted variant. */
export function homeProductMatches(itemId: string | null, productId: string): boolean {
  const definition = definitions.find((entry) => entry.id === productId);
  return !definition || definition.itemId === itemId;
}

function hasSource(sources: ProductPage[]): boolean {
  return sources.some((source) => source.id === HOME_EVIDENCE_ID && source.url === `local:${HOME_EVIDENCE_ID}` && source.error === null);
}

type Evidence = Pick<PricingChangeInput, "priceEvidence" | "oldItemHandling" | "oldItemCostCents" | "oldItemNote"> & {
  after: Partial<PricingItem> | null;
};

const fromDocuments = "Source: HOME_SUPPLIER_NOTES.";
const chosen = (definition: Definition, after: DraftChange["after"]) =>
  !!after && after.sku === definition.sku && after.unitPriceCents === definition.price && after.currency === "USD" && after.unitLabel === definition.unit;
const offered = (definition: Definition): Partial<PricingItem> => ({
  taxCents: 0, freightCents: 0, sourceUrl: null, leadTimeDays: definition.lead, category: "furniture", ...definition.terms,
});

/**
 * Populate suggestions only where the documents back them: the exact original SKU and price, a
 * product the documents offer, and the documents' own terms. Every amount here is a proposal for
 * the designer to check, not a receipt.
 */
export function homePricingEvidence(quote: ApprovedQuoteReport, change: DraftChange, sources: ProductPage[]): Evidence | null {
  if (!isHomeQuote(quote) || !hasSource(sources)) return null;
  if (change.action === "add") {
    const definition = definitions.find((entry) => entry.id === change.productOptionId && entry.itemId === null);
    if (!definition || !chosen(definition, change.after)) return null;
    return { after: offered(definition), priceEvidence: product(definition).priceEvidence!, oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "" };
  }
  const original = HOME_APPROVED_QUOTE.lines.find((line) => line.itemId === change.itemId);
  const before = quote.lines.find((line) => line.itemId === change.itemId);
  if (!original || !before || before.sku !== original.sku || before.quantity !== original.quantity || before.unitPriceCents !== original.unitPriceCents || before.taxCents !== 0 || before.freightCents !== 0) return null;
  const unchangedTerms = (lead: number | null): Partial<PricingItem> => ({
    taxCents: 0, freightCents: 0, sourceUrl: null, leadTimeDays: lead, returnPolicy: before.returnPolicy,
    returnable: before.nonReturnable === null ? null : !before.nonReturnable, restockingFeeBps: before.restockingFeeBps, customMade: before.customMade,
  });
  const after = change.after;

  if (change.itemId === "wall-tile" && change.action === "replace") {
    const definition = definitions.find((entry) => entry.id === change.productOptionId && entry.itemId === "wall-tile");
    if (!definition || !chosen(definition, after)) return null;
    const paid = before.quantity * before.unitPriceCents, kept = paid * (before.restockingFeeBps ?? 0) / 10_000;
    return {
      after: offered(definition), priceEvidence: product(definition).priceEvidence!,
      oldItemHandling: "returned", oldItemCostCents: kept,
      oldItemNote: `MAPLE-CAFE-TILE-01: return the ${before.quantity} unopened white boxes. The supplier keeps 20% (${usd(kept)}) as its restocking fee and credits ${usd(paid - kept)}; the refund waits for that credit. This proposal does not record a return, credit or refund as completed.`,
    };
  }
  if (!after || change.action !== "quantity") return null;
  if (change.itemId === "countertop" && after.quantity < before.quantity) {
    const removed = before.quantity - after.quantity, fee = 28_000;
    return {
      after: unchangedTerms(before.leadTimeDays),
      priceEvidence: `Local fictional document MAPLE-CAFE-QUARTZ-01: keep ${after.quantity} linear feet of the same ${before.sku} at USD 180 per foot; whole-line tax USD 0 and delivery USD 0. A cut top is re-cut shorter for a fixed USD 280 fee; the removed length is credited at the per-foot price. ${fromDocuments}`,
      oldItemHandling: "cancelled", oldItemCostCents: fee,
      oldItemNote: `MAPLE-CAFE-QUARTZ-01: re-cut the front counter top, removing ${removed} linear feet. The fabricator keeps its USD 280 re-cut fee and credits ${usd(removed * before.unitPriceCents)} for the removed length, so the planned refund of ${usd(removed * before.unitPriceCents - fee)} waits for that credit. This proposal does not record a re-cut, credit or refund as completed.`,
    };
  }
  if (change.itemId === "pendants" && after.quantity < before.quantity) {
    return {
      after: unchangedTerms(21),
      priceEvidence: `Local fictional document MAPLE-CAFE-PENDANT-01: keep ${after.quantity} of the same ${before.sku} at USD 240 each; whole-line tax USD 0 and delivery USD 0. Unordered excess lights have no retained cost. ${fromDocuments}`,
      oldItemHandling: "not_ordered", oldItemCostCents: 0,
      oldItemNote: `MAPLE-CAFE-PENDANT-01: ${before.quantity - after.quantity} excess pendants are not ordered; proposed retained cost USD 0. The reduced scope still needs designer and client confirmation.`,
    };
  }
  if (change.itemId === "stools" && after.quantity > before.quantity) {
    return {
      after: unchangedTerms(21),
      priceEvidence: `Local fictional document MAPLE-CAFE-STOOL-01: ${after.quantity} of the same ${before.sku} at USD 195 each; whole-line tax USD 0 and delivery USD 0. ${fromDocuments}`,
      oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "",
    };
  }
  if (change.itemId === "site-visits" && after.quantity > before.quantity) {
    return {
      after: unchangedTerms(null),
      priceEvidence: `Local fictional document MAPLE-CAFE-SERVICE-02: ${after.quantity} site visits at USD 180 per visit. ${fromDocuments}`,
      oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "",
    };
  }
  return null;
}

export const HOME_REVIEW_TERMS = "Local fictional Maple Ave Café supplier documents: use the selected lines' quantities, USD unit prices and listed return, re-cut and cancellation terms. Whole-line tax and delivery are explicitly USD 0 in this demo. Include only the retained costs listed for this proposed scope. Any planned refund requires its separate supplier-credit record and PayPal result. These proposed terms require designer review and client confirmation; they are not stock, order, return or payment receipts. Unchanged lines, including the design fee, keep their approved scope and price.";
