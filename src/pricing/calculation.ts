import { z } from "zod";
import type { ApprovedQuoteLine, ApprovedQuoteReport } from "@/quotes/types";
import { calculateLineTotals, calculateQuoteTotals, type QuoteTotals } from "../quotes/totals";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { CaseMessage, ChangeDraft, DraftChange, DraftItem, SupplierTerms } from "@/chat/types";
import { differences } from "./review-diff";
import { HOME_REVIEW_TERMS, homePricingEvidence } from "@/demo/home-evidence";
import type { ChangeSource, FinalQuoteLine, PricingChangeInput, PricingDocumentBody, PricingInput, PricingItem, PricingPreview, ReviewedChange } from "./types";

const MAX_CENTS = 2_000_000_000;
const cents = z.number().int().min(0).max(MAX_CENTS);
const text = (max: number) => z.string().max(max);
const sourceUrl = z.string().max(4096).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Source links must be HTTPS addresses without login credentials").nullable();

export const pricingInputSchema = z.strictObject({
  baselineFingerprint: z.string().min(1).max(1_000_000),
  title: text(300),
  changes: z.array(z.strictObject({
    key: z.string().min(1).max(100),
    action: z.enum(["quantity", "remove", "replace", "add"]),
    itemId: z.string().min(1).max(300).nullable(),
    after: z.strictObject({
      name: text(500), vendor: text(500), brand: text(300).nullable(), sku: text(300),
      specification: text(10_000), category: z.enum(["furniture", "service"]), room: text(500),
      quantity: z.number().int().min(1).max(10_000), unitLabel: text(100), currency: text(12).nullable(),
      unitPriceCents: cents.nullable(), taxCents: cents.nullable(), freightCents: cents.nullable(),
      sourceUrl, returnPolicy: text(10_000), returnable: z.boolean().nullable(),
      restockingFeeBps: z.number().int().min(0).max(10_000).nullable(),
      customMade: z.boolean(), leadTimeDays: z.number().int().min(0).max(36_500).nullable(),
    }).nullable(),
    priceEvidence: text(30_000), confirmed: z.boolean(),
    oldItemHandling: z.enum(["pending", "not_ordered", "cancelled", "returned", "retained", "not_applicable"]),
    oldItemCostCents: cents.nullable(), oldItemNote: text(10_000),
    fromV1: z.strictObject({ itemId: text(300), kind: z.enum(["revised", "carried"]), reason: text(10_000).nullable() }).optional(),
  })).min(1).max(100),
  issues: z.array(z.strictObject({ id: z.string().min(1).max(100), label: text(10_000), resolved: z.boolean(), note: text(10_000) })).max(300),
  terms: text(30_000), reviewNotes: text(20_000),
  source: z.strictObject({ kind: z.enum(["client", "designer", "vendor"]), vendor: text(300), notice: text(10_000) }).optional(),
});

/** A draft follows a supplier's notice, or otherwise the conversation with the client, whoever wrote it. */
export function draftSource(draft: Pick<ChangeDraft, "supplierNotice">): ChangeSource {
  if (draft.supplierNotice) return { kind: "vendor", ...draft.supplierNotice };
  return { kind: "client", vendor: "", notice: "" };
}

/** How a version's source reads; versions frozen with the old "designer" source read as the client conversation. */
export function changeSourceLabel(source: Pick<ChangeSource, "kind">): string {
  return source.kind === "vendor" ? "Supplier notice" : "Client conversation";
}

const usd = (value: number) => (value / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** What a supplier's order confirmation states for a line. */
export interface SupplierConfirmation extends SupplierTerms {
  quantity: number;
  unitPriceCents: number;
}

/** Where the supplier's confirmation differs from the approved line, as the client reads it; empty when it matches. */
export function supplierDifferences(line: Pick<ApprovedQuoteLine, "quantity" | "unitPriceCents" | "taxCents" | "freightCents">, supplier: SupplierConfirmation): string[] {
  return [
    supplier.quantity !== line.quantity && `quantity ${line.quantity} → ${supplier.quantity}`,
    supplier.unitPriceCents !== line.unitPriceCents && `unit price ${usd(line.unitPriceCents)} → ${usd(supplier.unitPriceCents)}`,
    supplier.taxCents !== line.taxCents && `tax ${usd(line.taxCents)} → ${usd(supplier.taxCents)}`,
    supplier.freightCents !== line.freightCents && `delivery ${usd(line.freightCents)} → ${usd(supplier.freightCents)}`,
  ].filter((entry): entry is string => !!entry);
}

const SUPPLIER_TERMS = "Each line started from a supplier's order confirmation follows that confirmation's quantity, unit price, tax and delivery. Every other line keeps its approved scope and price.";

function supplierEvidence(after: DraftItem, supplier: SupplierTerms): string {
  const lead = supplier.leadTimeDays === null ? "" : `, lead time ${supplier.leadTimeDays} days`;
  return `Supplier order confirmation ${supplier.reference}${after.vendor ? ` from ${after.vendor}` : ""}: ${after.quantity} × ${usd(after.unitPriceCents ?? 0)}, tax ${usd(supplier.taxCents)}, delivery ${usd(supplier.freightCents)}${lead}. Entered by the designer from the supplier's confirmation.`;
}

export class PricingValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[] | string) {
    const entries = typeof problems === "string" ? [problems] : problems;
    super(entries.join("; "));
    this.name = "PricingValidationError";
    this.problems = [...entries];
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
export function requiresOldItemHandling(change: { action: DraftChange["action"]; itemId: string | null; after: { quantity: number } | null }, before?: ApprovedQuoteLine): boolean {
  return change.action === "replace" || change.action === "remove" || (change.action === "quantity" && before !== undefined && change.after !== null && change.after.quantity < before.quantity);
}

function baseline(quote: ApprovedQuoteReport, draft: ChangeDraft): Map<string, ApprovedQuoteLine> {
  if (draft.basedOnQuoteId !== quote.id || draft.basedOnVersion !== quote.version || draft.projectKey !== quote.projectId) throw new PricingValidationError("The change draft does not match the current approved quote. Review pricing again.");
  if (draft.basedOnQuoteFingerprint !== undefined && draft.basedOnQuoteFingerprint !== quoteFingerprint(quote)) throw new PricingValidationError("The approved quote has changed. Ask @Coordinator in the chat for a new draft, then review pricing again.");
  if (!draft.changes.length || draft.changes.length > 100) throw new PricingValidationError("A change draft must contain 1 to 100 changed lines.");
  const byId = new Map(quote.lines.map((line) => [line.itemId, line]));
  if (byId.size !== quote.lines.length) throw new PricingValidationError("The approved quote contains duplicate item IDs.");
  const touched = new Set<string>();
  for (const change of draft.changes) {
    if (change.action === "add") {
      if (change.itemId !== null) throw new PricingValidationError("An added line cannot refer to an item in the approved quote.");
    } else {
      if (!change.itemId || !byId.has(change.itemId) || touched.has(change.itemId)) throw new PricingValidationError("A change refers to an unknown or duplicated item in the approved quote.");
      touched.add(change.itemId);
      if (draft.basedOnQuoteFingerprint === undefined) {
        const previous = byId.get(change.itemId)!;
        const before = change.before;
        if (!before || before.name !== previous.name || before.vendor !== previous.vendor || before.sku !== previous.sku || before.specification !== previous.specification || before.quantity !== previous.quantity || before.unitLabel !== (previous.unitLabel ?? "each") || before.unitPriceCents !== previous.unitPriceCents || before.currency !== "USD") throw new PricingValidationError("The original item in this older draft no longer matches the approved quote. Ask @Coordinator in the chat for a new draft.");
      }
    }
    if ((change.action === "remove") !== (change.after === null)) throw new PricingValidationError("The change type does not match the draft's new line.");
  }
  return byId;
}

/** Draft prices are suggestions. Tax, delivery and human confirmation start unknown. */
function v1PricingChange(key: string, change: DraftChange): PricingChangeInput {
  const { line, ...fromV1 } = change.fromV1!;
  const after = change.after!;
  return {
    key, action: change.action, itemId: change.itemId,
    after: {
      name: after.name, vendor: after.vendor ?? line.vendor, brand: after.brand, sku: after.sku ?? line.sku, specification: after.specification,
      category: line.category, room: line.room, quantity: after.quantity, unitLabel: after.unitLabel ?? line.unitLabel ?? "each", currency: "USD",
      unitPriceCents: after.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents, sourceUrl: line.source.url ?? null,
      returnPolicy: line.returnPolicy, returnable: line.nonReturnable === null ? null : !line.nonReturnable,
      restockingFeeBps: line.restockingFeeBps, customMade: line.customMade, leadTimeDays: line.leadTimeDays,
    },
    priceEvidence: fromV1.kind === "carried"
      ? `Carried over unchanged from quote V1 as sent: ${line.source.name} (${line.source.reference}).`
      : `Revised from a quote V1 line the client declined. As sent in V1: ${line.source.name} (${line.source.reference}), ${line.quantity} × ${line.unitPriceCents} cents.`,
    confirmed: false, oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "", fromV1,
  };
}

export function createPricingInput(quote: ApprovedQuoteReport, draft: ChangeDraft): PricingInput {
  const old = baseline(quote, draft);
  const evidence = draft.changes.map((change) => homePricingEvidence(quote, change, draft.sources));
  const sourced = evidence.length > 0 && evidence.every((entry) => entry !== null);
  return {
    baselineFingerprint: quoteFingerprint(quote),
    title: draft.title,
    changes: draft.changes.map((change, index) => {
      // A line coming back from V1 starts from that line as it was sent, so the designer edits rather than retypes it.
      if (change.fromV1 && change.after) return v1PricingChange(`change-${index}`, change);
      const previous = change.itemId ? old.get(change.itemId) : undefined;
      const source = draft.sources.find((page) => !page.error && page.products.some((product) => product.id === change.productOptionId));
      const product = source?.products.find((option) => option.id === change.productOptionId);
      const after = change.after;
      const price = after?.unitPriceCents;
      const needsOldHandling = requiresOldItemHandling(change, previous);
      const suggestion = evidence[index];
      // A change started from a supplier's order confirmation carries what the supplier confirmed.
      const supplier = change.supplier;
      return {
        key: `change-${index}`, action: change.action, itemId: change.itemId,
        after: after ? {
          name: after.name, vendor: after.vendor ?? "", brand: after.brand, sku: after.sku ?? "",
          specification: after.specification, category: previous?.category ?? "furniture", room: previous?.room ?? quote.room,
          quantity: after.quantity, unitLabel: after.unitLabel ?? "", currency: after.currency,
          unitPriceCents: price !== null && price !== undefined && Number.isSafeInteger(price) && price >= 0 && price <= MAX_CENTS ? price : null,
          taxCents: null, freightCents: null,
          sourceUrl: source?.url.startsWith("local:") ? null : source?.url ?? (change.action === "quantity" ? previous?.source.url ?? null : null),
          returnPolicy: change.action === "quantity" ? previous?.returnPolicy ?? "" : "",
          returnable: change.action === "quantity" && previous?.nonReturnable !== null && previous?.nonReturnable !== undefined ? !previous.nonReturnable : null,
          restockingFeeBps: change.action === "quantity" ? previous?.restockingFeeBps ?? null : null,
          customMade: change.action === "quantity" ? previous?.customMade ?? false : false,
          leadTimeDays: change.action === "quantity" ? previous?.leadTimeDays ?? null : null,
          ...suggestion?.after,
          ...(supplier ? { taxCents: supplier.taxCents, freightCents: supplier.freightCents, leadTimeDays: supplier.leadTimeDays ?? previous?.leadTimeDays ?? null } : {}),
        } : null,
        priceEvidence: supplier && after ? supplierEvidence(after, supplier) : suggestion?.priceEvidence ?? product?.priceEvidence ?? (change.action === "quantity" && previous ? JSON.stringify({ source: previous.source, sku: previous.sku, unitPriceCents: previous.unitPriceCents, unitLabel: previous.unitLabel ?? null }) : ""),
        confirmed: false,
        oldItemHandling: suggestion?.oldItemHandling ?? (needsOldHandling ? "pending" : "not_applicable"),
        oldItemCostCents: suggestion?.oldItemCostCents ?? (needsOldHandling ? null : 0),
        oldItemNote: suggestion?.oldItemNote ?? "",
      };
    }),
    issues: draft.unresolved.map((label, index) => ({ id: `issue-${index}`, label, resolved: false, note: "" })),
    terms: sourced ? HOME_REVIEW_TERMS : draft.changes.some((change) => change.supplier) ? SUPPLIER_TERMS : "", reviewNotes: sourced ? "Pricing suggestions reference Setti's local fictional supplier documents, not uploaded files or live supplier/payment confirmations. Every line and open issue still needs the designer's explicit check." : "", source: draftSource(draft),
  };
}

/** Shape and immutable identity checks apply even when saving an incomplete review. */
export function validatePricingInput(quote: ApprovedQuoteReport, draft: ChangeDraft, value: unknown): PricingInput {
  const old = baseline(quote, draft);
  const input = pricingInputSchema.parse(value);
  if (input.baselineFingerprint !== quoteFingerprint(quote)) throw new PricingValidationError("The approved quote has changed, so this pricing review cannot be reused. Review pricing again.");
  const source = createPricingInput(quote, draft);
  const changes = new Map(input.changes.map((change) => [change.key, change]));
  if (changes.size !== input.changes.length || changes.size !== source.changes.length) throw new PricingValidationError("Pricing lines cannot be added, removed or duplicated. Review pricing from the original change draft.");
  const ordered = source.changes.map((expected) => {
    const actual = changes.get(expected.key);
    if (!actual || actual.action !== expected.action || actual.itemId !== expected.itemId || (actual.after === null) !== (expected.after === null)) throw new PricingValidationError("A pricing line's ID, action or original item cannot be changed.");
    if (actual.action === "quantity") {
      const previous = old.get(actual.itemId!)!;
      const after = actual.after!;
      if (after.name !== previous.name || after.vendor !== previous.vendor || after.sku !== previous.sku || after.specification !== previous.specification || after.category !== previous.category || after.unitLabel !== (previous.unitLabel ?? "each")) throw new PricingValidationError("A quantity change cannot switch to another product or pricing unit. To swap products, ask @Coordinator in the chat for a replacement draft.");
    }
    if (requiresOldItemHandling(actual, actual.itemId ? old.get(actual.itemId) : undefined)) {
      if (actual.oldItemHandling === "not_applicable") throw new PricingValidationError("Replacing, removing or reducing an item requires verified old-item handling.");
    } else if (actual.oldItemHandling !== "not_applicable" || actual.oldItemCostCents !== 0) throw new PricingValidationError("Added quantities or new items cannot carry old-item handling costs.");
    const edited: PricingChangeInput = { ...actual };
    delete edited.fromV1;
    if (expected.fromV1) edited.fromV1 = expected.fromV1;
    return edited;
  });
  const issues = new Map(input.issues.map((issue) => [issue.id, issue]));
  if (issues.size !== input.issues.length || issues.size !== source.issues.length) throw new PricingValidationError("Open questions cannot be added, removed or duplicated.");
  const orderedIssues = source.issues.map((expected) => {
    const actual = issues.get(expected.id);
    if (!actual || actual.label !== expected.label) throw new PricingValidationError("An open question's ID or original text cannot be changed.");
    return actual;
  });
  return { ...input, changes: ordered, issues: orderedIssues };
}

function unchanged(line: ApprovedQuoteLine): FinalQuoteLine {
  return {
    itemId: line.itemId, name: line.name, vendor: line.vendor, brand: null, sku: line.sku,
    specification: line.specification, category: line.category, room: line.room,
    quantity: line.quantity, unitLabel: line.unitLabel ?? "each", currency: "USD", unitPriceCents: line.unitPriceCents,
    taxCents: line.taxCents, freightCents: line.freightCents, sourceUrl: line.source.url ?? null,
    returnPolicy: line.returnPolicy, returnable: line.nonReturnable === null ? null : !line.nonReturnable,
    restockingFeeBps: line.restockingFeeBps, customMade: line.customMade, leadTimeDays: line.leadTimeDays,
    origin: "unchanged",
  };
}

function finalAfter(draft: ChangeDraft, change: PricingChangeInput): FinalQuoteLine | null {
  if (!change.after) return null;
  const item = change.after;
  if (item.currency !== "USD" || item.unitPriceCents === null || item.taxCents === null || item.freightCents === null) return null;
  const itemId = change.itemId ?? (change.fromV1?.kind === "carried" ? change.fromV1.itemId : `new-${draft.id}-${change.key}`);
  return { ...clone(item), itemId, currency: "USD", unitPriceCents: item.unitPriceCents, taxCents: item.taxCents, freightCents: item.freightCents, origin: "changed" };
}

function feeLine(draft: ChangeDraft, change: PricingChangeInput, before: ApprovedQuoteLine): FinalQuoteLine {
  return {
    itemId: `old-cost-${draft.id}-${change.key}`, name: `Old item retention and handling cost: ${before.name}`, vendor: before.vendor,
    brand: null, sku: `OLD-COST-${change.key}`,
    specification: `${change.oldItemNote.trim()}. This line includes every verified cost and applicable tax for keeping, cancelling or returning the old item. It is charged as one amount, with no further tax or delivery.`,
    category: "service", room: before.room, quantity: 1, unitLabel: "total", currency: "USD",
    unitPriceCents: change.oldItemCostCents!, taxCents: 0, freightCents: 0, sourceUrl: null,
    returnPolicy: "This line is the designer-verified total cost of handling the old item. This change order's terms and old-item notes govern how it is handled or returned.",
    returnable: null, restockingFeeBps: null, customMade: false, leadTimeDays: null, origin: "old_item_cost",
  };
}

function assembledLines(quote: ApprovedQuoteReport, draft: ChangeDraft, input: PricingInput): FinalQuoteLine[] | null {
  const byItem = new Map(input.changes.filter((change) => change.itemId).map((change) => [change.itemId, change]));
  const lines: FinalQuoteLine[] = [];
  for (const before of quote.lines) {
    const change = byItem.get(before.itemId);
    if (!change) { lines.push(unchanged(before)); continue; }
    if (change.after) {
      const after = finalAfter(draft, change);
      if (!after) return null;
      lines.push(after);
    }
    if (requiresOldItemHandling(change, before)) {
      if (change.oldItemCostCents === null) return null;
      if (change.oldItemCostCents > 0) lines.push(feeLine(draft, change, before));
    }
  }
  for (const change of input.changes.filter((entry) => entry.action === "add")) {
    const after = finalAfter(draft, change);
    if (!after) return null;
    lines.push(after);
  }
  return lines;
}

function boundedTotals(lines: readonly { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number }[]) {
  for (const line of lines) {
    const values = [line.unitPriceCents, line.taxCents, line.freightCents, calculateLineTotals(line).totalCents];
    if (values.some((amount) => amount > MAX_CENTS)) throw new PricingValidationError("A line amount exceeds the safe limit. Split the line or verify the quote again.");
  }
  const totals = calculateQuoteTotals(lines);
  if ([totals.subtotalCents, totals.taxCents, totals.freightCents, totals.totalCents].some((amount) => amount > MAX_CENTS)) throw new PricingValidationError("The quote total exceeds the safe limit. Verify it again.");
  return totals;
}

function commercialValue(line: FinalQuoteLine): string {
  return JSON.stringify([line.itemId, line.name.trim(), line.vendor.trim(), line.brand, line.sku.trim(), line.specification.trim(), line.category, line.room.trim(), line.quantity, line.unitLabel.trim(), line.currency, line.unitPriceCents, line.taxCents, line.freightCents, line.returnPolicy.trim(), line.returnable, line.restockingFeeBps, line.customMade, line.leadTimeDays]);
}

function noCommercialChange(quote: ApprovedQuoteReport, lines: FinalQuoteLine[]): boolean {
  const old = quote.lines.map((line) => commercialValue(unchanged(line))).sort();
  const proposed = lines.map(commercialValue).sort();
  return JSON.stringify(old) === JSON.stringify(proposed);
}

/** Missing metadata may coexist with a known amount; missing money never becomes zero. */
export function previewPricing(quote: ApprovedQuoteReport, draft: ChangeDraft, value: PricingInput): PricingPreview {
  const baselineTotals = boundedTotals(quote.lines);
  let input: PricingInput;
  try { input = validatePricingInput(quote, draft, value); }
  catch (error) {
    const problems = error instanceof PricingValidationError ? error.problems : error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) : ["The pricing details are invalid."];
    return { baselineTotals, proposedTotals: null, deltaTotalCents: null, problems, ready: false };
  }
  const problems: string[] = [];
  const originalCurrencies = new Map(draft.changes.map((change, index) => [`change-${index}`, change.after?.currency ?? null]));
  const initialEvidence = new Map(createPricingInput(quote, draft).changes.map((change) => [change.key, change.priceEvidence]));
  if (!input.title.trim()) problems.push("Enter a change order title.");
  if (!input.terms.trim()) problems.push("Enter the terms for this quote and old-item handling.");
  if (input.source?.kind === "vendor" && (!input.source.vendor.trim() || !input.source.notice.trim())) problems.push("Name the supplier and enter what its notice says, so the client sees why the price changed.");
  for (const [index, change] of input.changes.entries()) {
    const label = change.after?.name.trim() || quote.lines.find((line) => line.itemId === change.itemId)?.name || change.key;
    if (!change.confirmed) problems.push(`${label}: the designer has not confirmed this line's pricing.`);
    const v1Line = draft.changes[index]?.fromV1?.line;
    const fromV1Fields = v1Line && change.after ? differences(v1Line, change.after) : [];
    if (change.fromV1?.kind === "carried" && fromV1Fields.length && change.priceEvidence.trim() === initialEvidence.get(change.key)?.trim()) {
      problems.push(`${label}: this line no longer matches quote V1 (${fromV1Fields.map((field) => field.label.toLowerCase()).join(", ")}). Update the price evidence to say what changed.`);
    }
    if (change.after) {
      const item = change.after;
      const required: [keyof PricingItem, string][] = [["name", "Name"], ["vendor", "Vendor"], ["sku", "SKU"], ["specification", "Specification"], ["room", "Room"], ["unitLabel", "Pricing unit"], ["returnPolicy", "Return or cancellation terms"]];
      for (const [key, name] of required) if (typeof item[key] !== "string" || !(item[key] as string).trim()) problems.push(`${label}: ${name} needs confirmation.`);
      if (item.currency !== "USD") problems.push(`${label}: confirm a USD price. Unknown or foreign-currency prices are not converted automatically.`);
      if (item.unitPriceCents === null) problems.push(`${label}: unit price needs confirmation.`);
      if (item.taxCents === null) problems.push(`${label}: tax for this line needs confirmation.`);
      if (item.freightCents === null) problems.push(`${label}: delivery for this line needs confirmation.`);
      if (!change.priceEvidence.trim()) problems.push(`${label}: enter the price evidence.`);
      if (originalCurrencies.get(change.key) !== "USD" && item.currency === "USD" && change.priceEvidence.trim() === initialEvidence.get(change.key)?.trim()) problems.push(`${label}: the original currency was not confirmed USD. Add USD price evidence; changing the currency label alone is not enough.`);
    }
    const before = quote.lines.find((line) => line.itemId === change.itemId);
    if (requiresOldItemHandling(change, before)) {
      if (change.oldItemHandling === "pending" || change.oldItemHandling === "not_applicable") problems.push(`${label}: old-item handling needs confirmation.`);
      if (change.oldItemCostCents === null) problems.push(`${label}: the full old-item handling cost needs confirmation. Enter 0 if there is no cost.`);
      if (!change.oldItemNote.trim()) problems.push(`${label}: describe the old-item handling and its cost.`);
      const retainedMinimum = change.action === "quantity" ? (before!.quantity - change.after!.quantity) * before!.unitPriceCents : calculateLineTotals(before!).totalCents;
      if (change.oldItemHandling === "retained" && change.oldItemCostCents !== null && change.oldItemCostCents < retainedMinimum) problems.push(change.action === "quantity" ? `${label}: keeping the reduced quantity costs at least its original unit prices in total. Verify the related tax and delivery in the notes.` : `${label}: keeping the old item costs at least its full original line total, including the original tax and delivery.`);
    }
  }
  for (const issue of input.issues) if (!issue.resolved) problems.push(`${issue.label}: mark it resolved before issuing.`);
  const lines = assembledLines(quote, draft, input);
  let proposedTotals: QuoteTotals | null = null;
  let deltaTotalCents: number | null = null;
  if (lines) {
    if (!lines.length) problems.push("The new quote must keep at least one line. Cancelling the whole project is out of scope for this version.");
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) problems.push("The new quote has conflicting item IDs.");
    try {
      proposedTotals = boundedTotals(lines);
      deltaTotalCents = proposedTotals.totalCents - baselineTotals.totalCents;
      if (!Number.isSafeInteger(deltaTotalCents)) throw new PricingValidationError("The quote difference is outside the safe range.");
      if (noCommercialChange(quote, lines)) problems.push("No quote content changed, so no change order is needed.");
    } catch (error) { problems.push(error instanceof Error ? error.message : "The quote amount is invalid."); proposedTotals = null; deltaTotalCents = null; }
  }
  return { baselineTotals, proposedTotals, deltaTotalCents, problems, ready: problems.length === 0 && lines !== null && lines.length > 0 && proposedTotals !== null };
}

/** Snapshot one complete V2; this creates neither a client approval nor a payment. */
export function prepareChangeOrder(quote: ApprovedQuoteReport, draft: ChangeDraft, value: PricingInput, messages: readonly CaseMessage[]): PricingDocumentBody {
  const input = validatePricingInput(quote, draft, value);
  const preview = previewPricing(quote, draft, input);
  if (!preview.ready || !preview.proposedTotals || preview.deltaTotalCents === null) throw new PricingValidationError(preview.problems.length ? preview.problems : ["Pricing is incomplete, so the change order cannot be issued yet."]);
  const lines = assembledLines(quote, draft, input)!;
  const sources = new Set([...draft.sourceMessageIds, ...draft.changes.flatMap((change) => change.sourceMessageIds)]);
  const sourceMessages = messages.filter((message) => sources.has(message.id));
  if (new Set(sourceMessages.map((message) => message.id)).size !== sources.size || sourceMessages.length !== sources.size || sourceMessages.some((message) => message.actor === "assistant")) throw new PricingValidationError("A change cites chat messages that are missing, duplicated or not written by a person. Check the sources again.");
  const reviewed: ReviewedChange[] = input.changes.map((change, index) => ({
    key: change.key, action: change.action, itemId: change.itemId,
    before: change.itemId ? clone(quote.lines.find((line) => line.itemId === change.itemId)!) : null,
    after: finalAfter(draft, change), oldItemHandling: change.oldItemHandling,
    oldItemCostCents: change.oldItemCostCents ?? 0, oldItemNote: change.oldItemNote,
    priceEvidence: change.priceEvidence,
    ...(change.fromV1 ? { fromV1: change.fromV1, changesFromV1: differences(draft.changes[index].fromV1!.line, change.after!) } : {}),
  }));
  return clone({
    projectKey: draft.projectKey, basedOnQuoteId: quote.id, basedOnVersion: quote.version, baselineFingerprint: input.baselineFingerprint,
    projectName: quote.projectName, clientName: quote.clientName, designerName: quote.designerName,
    currency: "USD", isDemo: true, title: input.title, sourceDraftId: draft.id, sourceDraftRevision: draft.revision,
    changes: reviewed, lines, baselineLines: [...quote.lines], baselineTotals: preview.baselineTotals,
    totals: preview.proposedTotals, deltaTotalCents: preview.deltaTotalCents,
    terms: input.terms, reviewNotes: input.reviewNotes, issues: input.issues, constraints: [...draft.constraints],
    sourceMessages: sourceMessages.map(({ id, actor, text, createdAt }) => ({ id, actor, text, createdAt })),
    sources: draft.sources,
    source: frozenSource(input.source ?? draftSource(draft)),
  });
}

/** Reviews saved before the merge may still say "designer"; new versions freeze it as the client conversation. */
function frozenSource(source: ChangeSource): ChangeSource {
  return source.kind === "vendor" ? { kind: "vendor", vendor: source.vendor.trim(), notice: source.notice.trim() } : { kind: "client", vendor: "", notice: "" };
}
