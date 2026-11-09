/** Fictional supplier inputs for the Maple walkthrough, explicitly loaded by its designer. */
import type { PricingInput, PricingItem } from "@/pricing/types";
import type { QuoteDocument } from "@/quotes/types";

export const MAPLE_MIXED_CHANGE_MESSAGE = "@Setti Please draft one change: replace the Lounge chair with one light oak writing desk, and return the Wool rug. Use the Maple sample desk; Jordan will review its sample supplier details on the pricing page. Keep all other items unchanged.";

export const MAPLE_SAMPLE_MATERIALS = {
  reference: "MAPLE-SAMPLE-Q1",
  supplier: "Maple Sample Furniture (demo)",
  desk: {
    name: "Light oak writing desk", sku: "DEMO-MAPLE-DESK-01", quantity: 1, unitLabel: "each",
    unitPriceCents: 110_000, taxCents: 0, freightCents: 0, leadTimeDays: 14,
    specification: "Light oak writing desk, standard finish · fictional Maple walkthrough product",
    returnPolicy: "Sample supplier terms: an unshipped order can be cancelled before supplier confirmation at no charge. Later returns and any retained cost require a new reviewed agreement and supplier credit.",
  },
  chair: { oldItemHandling: "not_ordered" as const, oldItemCostCents: 0, oldItemFees: [],
    note: "Sample cancellation note MAPLE-SAMPLE-Q1: the original lounge chair has not been ordered. No goods are kept and no cancellation cost is retained." },
  rug: { oldItemHandling: "returned" as const, oldItemCostCents: 6_000, oldItemFees: [{ kind: "restocking_fee" as const, amountCents: 6_000 }],
    note: "Sample return note MAPLE-SAMPLE-Q1: return the wool rug. The supplier retains USD 60 total (20% of USD 300), including all applicable handling, tax and delivery costs; the remaining USD 240 waits for the supplier's credit before refund." },
  terms: "Maple walkthrough terms (fictional): replace the lounge chair with one light oak writing desk at USD 1,100, line tax USD 0 and delivery USD 0. The chair was not ordered and has no retained cost. Return the wool rug with an inclusive USD 60 retained cost; its USD 240 refund waits for supplier credit. Other quote lines stay unchanged. The client confirms this scope, pricing and handling; payment steps are recorded separately after confirmation. Desk capture waits for matching supplier confirmation.",
} as const;

/** The example is offered only while the original two Maple items still have its sample prices. */
export function isMapleSampleScope(quote: Pick<QuoteDocument, "projectId" | "lines">): boolean {
  if (quote.projectId !== "maple") return false;
  return ([{ id: "chair", cents: 80_000 }, { id: "rug", cents: 30_000 }] as const).every(({ id, cents }) => {
    const line = quote.lines.find((entry) => entry.itemId === id);
    return line?.category === "furniture" && line.quantity === 1 && line.unitPriceCents === cents && line.taxCents === 0 && line.freightCents === 0;
  });
}

/** Match the request's scope, not an exact model-generated product name. Real sourced products stay separate. */
export function canLoadMapleSampleMaterials(quote: Pick<QuoteDocument, "projectId" | "lines">, input: PricingInput): boolean {
  if (!isMapleSampleScope(quote) || input.changes.length !== 2 || input.changes.some((change) => change.fromV1)) return false;
  const desk = input.changes.find((change) => change.itemId === "chair" && change.action === "replace")?.after;
  const rug = input.changes.find((change) => change.itemId === "rug" && change.action === "remove");
  return !!desk && !!rug && rug.after === null && desk.quantity === 1 && desk.category === "furniture"
    && /desk|writing\s+table/i.test(`${desk.name} ${desk.specification}`)
    && !desk.sourceUrl && (desk.unitPriceCents === null || desk.unitPriceCents === MAPLE_SAMPLE_MATERIALS.desk.unitPriceCents)
    && (desk.currency === null || desk.currency === "USD");
}

/** Copies source values into editable fields; approvals and open questions remain the designer's work. */
export function loadMapleSampleMaterials(quote: Pick<QuoteDocument, "projectId" | "lines">, input: PricingInput): PricingInput | null {
  if (!canLoadMapleSampleMaterials(quote, input)) return null;
  const result = structuredClone(input);
  const sample = MAPLE_SAMPLE_MATERIALS;
  result.changes = result.changes.map((change) => {
    if (change.itemId === "chair" && change.after) {
      const after: PricingItem = { ...change.after, ...sample.desk, vendor: sample.supplier, brand: null, currency: "USD", sourceUrl: null,
        room: change.after.room || quote.lines.find((line) => line.itemId === "chair")!.room,
        returnable: true, restockingFeeBps: null, customMade: false };
      return { ...change, after, confirmed: false, oldItemHandling: sample.chair.oldItemHandling, oldItemCostCents: sample.chair.oldItemCostCents,
        oldItemFees: [...sample.chair.oldItemFees], oldItemNote: sample.chair.note,
        priceEvidence: `Fictional sample supplier quote ${sample.reference}: ${sample.supplier}; ${sample.desk.sku}; 1 each at USD 1,100; whole-line tax USD 0 and delivery USD 0; sample lead time 14 days. Loaded from Setti's local walkthrough materials for designer review.` };
    }
    return { ...change, confirmed: false, oldItemHandling: sample.rug.oldItemHandling, oldItemCostCents: sample.rug.oldItemCostCents,
      oldItemFees: sample.rug.oldItemFees.map((fee) => ({ ...fee })), oldItemNote: sample.rug.note, priceEvidence: `Fictional sample return note ${sample.reference}: USD 300 original rug, inclusive retained cost USD 60, supplier credit USD 240 before refund.` };
  });
  if (!result.terms.trim()) result.terms = sample.terms;
  if (!result.reviewNotes.trim()) result.reviewNotes = `Source: ${sample.reference}, Setti's fictional Maple supplier quote and cancellation / return notes. Designer review remains required.`;
  return result;
}
