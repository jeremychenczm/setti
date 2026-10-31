/** Local fictional supplier documents, never an uploaded file or a live supplier feed. */
import type { DraftChange, ProductOption, ProductPage } from "@/chat/types";
import type { PricingChangeInput, PricingItem } from "@/pricing/types";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import { HOME_APPROVED_QUOTE, HOME_SUPPLIER_NOTES } from "./living-dining";

export const HOME_EVIDENCE_ID = "maple-living-dining-supplier-notes-v1";
export const HOME_PRODUCT_IDS = {
  sofa: "maple-ld:compact-sofa",
  "coffee-table": "maple-ld:small-side-table",
  "dining-table": "maple-ld:round-dining-table",
} as const;

export function isHomeQuote(quote: Pick<QuoteDocument, "projectId" | "lines">): boolean {
  return quote.projectId === "maple" && quote.lines.some((line) => ["sofa", "coffee-table", "dining-table", "dining-chairs", "sideboard"].includes(line.itemId));
}

const cancellation = "Local fictional supplier terms: cancel an unplaced order without a retained cost. No supplier order is placed by this draft.";
const definitions = [
  { itemId: "sofa", id: HOME_PRODUCT_IDS.sofa, name: "Compact sofa", sku: "DEMO-LD-SOFA-200", specification: "Straight compact sofa, 200 × 90 × 80 cm; warm neutral fabric; no chaise", price: 210_000, lead: 21, reference: "MAPLE-LD-SOFA-01" },
  { itemId: "coffee-table", id: HOME_PRODUCT_IDS["coffee-table"], name: "Small round side table", sku: "DEMO-LD-SIDE-40", specification: "Movable light oak round side table, 40 cm diameter × 50 cm high; light enough to lift; quoted per individual side table", price: 18_000, lead: 14, reference: "MAPLE-LD-COFFEE-01" },
  { itemId: "dining-table", id: HOME_PRODUCT_IDS["dining-table"], name: "Round dining table", sku: "DEMO-LD-ROUND-110", specification: "Fixed round light oak dining table, 110 cm diameter × 75 cm high, four seats; no extension", price: 125_000, lead: 21, reference: "MAPLE-LD-DINING-01" },
] as const;

function product(definition: typeof definitions[number]): ProductOption {
  return {
    id: definition.id, name: definition.name, sku: definition.sku, brand: null, seller: HOME_APPROVED_QUOTE.lines.find((line) => line.itemId === definition.itemId)!.vendor,
    specification: definition.specification, currency: "USD", unitPriceCents: definition.price, unitLabel: "each",
    priceEvidence: `Local fictional supplier document ${definition.reference}: ${definition.sku}; USD ${(definition.price / 100).toFixed(2)} per each. Whole-line tax USD 0 and delivery USD 0. Source: HOME_SUPPLIER_NOTES, included in this demo, not an uploaded or verified supplier file.`,
    availability: "Sample lead time only; actual stock and accepted orders require a separate supplier confirmation.",
  };
}

export function HOME_EVIDENCE_PAGE(now = new Date().toISOString()): ProductPage {
  return {
    id: HOME_EVIDENCE_ID, url: `local:${HOME_EVIDENCE_ID}`, fetchedAt: now,
    title: "Local fictional supplier documents · Maple living & dining", text: HOME_SUPPLIER_NOTES,
    products: definitions.map(product), error: null,
  };
}

/** Product selection must refer to this item's own replacement, not another quoted variant. */
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

/** Populate suggestions only where the exact original SKU/price and chosen product have a source. */
export function homePricingEvidence(quote: ApprovedQuoteReport, change: DraftChange, sources: ProductPage[]): Evidence | null {
  if (!isHomeQuote(quote) || !hasSource(sources)) return null;
  const original = HOME_APPROVED_QUOTE.lines.find((line) => line.itemId === change.itemId);
  const before = quote.lines.find((line) => line.itemId === change.itemId);
  if (!original || !before || before.sku !== original.sku || before.quantity !== original.quantity || before.unitPriceCents !== original.unitPriceCents || before.taxCents !== 0 || before.freightCents !== 0) return null;
  const definition = definitions.find((entry) => entry.id === change.productOptionId && entry.itemId === change.itemId);
  if (definition && change.action === "replace" && change.after) {
    const option = product(definition);
    if (change.after.sku !== option.sku || change.after.unitPriceCents !== option.unitPriceCents || change.after.currency !== "USD" || change.after.unitLabel !== "each") return null;
    return {
      after: { taxCents: 0, freightCents: 0, returnPolicy: `${cancellation} Standard unused goods can be returned within 14 days with prior approval, retaining ${definition.itemId === "coffee-table" ? "10%" : "15%"} of the goods price.`, returnable: true, restockingFeeBps: definition.itemId === "coffee-table" ? 1000 : 1500, customMade: false, leadTimeDays: definition.lead, sourceUrl: null },
      priceEvidence: option.priceEvidence!, oldItemHandling: "not_ordered", oldItemCostCents: 0,
      oldItemNote: `${definition.reference}: the original ${before.name} has not been ordered in this fictional scenario. Proposed cancellation retains USD 0; this is a pricing assumption for review, not a cancellation or payment receipt.`,
    };
  }
  if (change.itemId === "dining-chairs" && change.action === "quantity" && change.after && change.after.quantity < before.quantity) {
    return {
      after: { taxCents: 0, freightCents: 0, returnPolicy: before.returnPolicy || cancellation, returnable: true, restockingFeeBps: 1000, customMade: false, leadTimeDays: 14, sourceUrl: null },
      priceEvidence: `Local fictional document MAPLE-LD-CHAIRS-01: retain ${change.after.quantity} of the same ${before.sku}, USD 180 per each; whole-line tax USD 0 and delivery USD 0. Unplaced excess chairs have no retained cost. Source: HOME_SUPPLIER_NOTES.`,
      oldItemHandling: "not_ordered", oldItemCostCents: 0,
      oldItemNote: `MAPLE-LD-CHAIRS-01: ${before.quantity - change.after.quantity} excess chairs are not ordered; proposed retained cost USD 0. The reduced scope still needs designer and client confirmation.`,
    };
  }
  if (change.itemId === "sideboard" && change.action === "remove") {
    return {
      after: null, priceEvidence: "Local fictional return document MAPLE-LD-SIDEBOARD-01: original sideboard USD 1,200; 20% inclusive retained cost USD 240; proposed supplier credit/refund USD 960, conditional on the separate recorded credit and PayPal refund steps.",
      oldItemHandling: "returned", oldItemCostCents: 24_000,
      oldItemNote: "MAPLE-LD-SIDEBOARD-01: arrange return of the sideboard; retain USD 240 total (20% of USD 1,200), including all handling, tax and delivery. The planned USD 960 refund waits for supplier credit. This proposal does not record a return, credit or refund as completed.",
    };
  }
  return null;
}

export const HOME_REVIEW_TERMS = "Local fictional Maple supplier documents: use the selected lines' quantities, per-item USD prices and listed return/cancellation terms. Whole-line tax and delivery are explicitly USD 0 in this demo. Include only the retained old-item costs listed for this proposed scope. Any planned refund requires its separate supplier-credit record and PayPal result. These proposed terms require designer review and client confirmation; they are not stock, order, return or payment receipts. Unchanged lines, including design services, keep their approved scope and price.";
