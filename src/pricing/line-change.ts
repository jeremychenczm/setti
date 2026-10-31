/**
 * The designer starts a change on a line of the current agreement, for example
 * after a supplier's price notice: the same product with another price,
 * quantity or terms. It enters the case's draft (the current one, or a new
 * designer draft) and is reviewed on the pricing page like any draft line, so
 * the client confirms it in a new version before any money moves. A change
 * started from a supplier's order confirmation that differs from the line
 * starts from what the supplier confirmed, with its notice as the reason.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { currentCaseQuote } from "../approval/baseline";
import { chatCases } from "../chat/schema";
import type { CaseKey, ChangeDraft, DraftChange } from "../chat/types";
import type { Db } from "../db/client";
import { withV1Lines } from "../opening/carry";
import { readOpening } from "../opening/read";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { ApprovedQuoteLine } from "../quotes/types";
import { supplierDifferences, type SupplierConfirmation } from "./calculation";
import { PricingStoreError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The line as it stands, as both sides of a change the designer then edits. */
function lineChange(line: ApprovedQuoteLine): DraftChange {
  const item = { name: line.name, vendor: line.vendor, brand: null, sku: line.sku, specification: line.specification, quantity: line.quantity, unitLabel: line.unitLabel ?? "each", unitPriceCents: line.unitPriceCents, currency: "USD" };
  const subtotal = line.quantity * line.unitPriceCents;
  return { action: "quantity", itemId: line.itemId, before: item, after: { ...item }, productOptionId: null, sourceMessageIds: [], beforeSubtotalCents: subtotal, afterSubtotalCents: subtotal, deltaSubtotalCents: 0 };
}

/** The line with the supplier's confirmed quantity and price; the rest of what it confirmed rides along for the pricing page. */
function supplierChange(line: ApprovedQuoteLine, supplier: SupplierConfirmation): DraftChange {
  const change = lineChange(line);
  const subtotal = supplier.quantity * supplier.unitPriceCents;
  return {
    ...change, after: { ...change.after!, quantity: supplier.quantity, unitPriceCents: supplier.unitPriceCents },
    afterSubtotalCents: subtotal, deltaSubtotalCents: subtotal - change.beforeSubtotalCents!,
    supplier: { reference: supplier.reference, taxCents: supplier.taxCents, freightCents: supplier.freightCents, leadTimeDays: supplier.leadTimeDays },
  };
}

function sameSupplier(change: DraftChange, supplier: SupplierConfirmation): boolean {
  return !!change.supplier && change.supplier.reference === supplier.reference && change.after?.quantity === supplier.quantity && change.after.unitPriceCents === supplier.unitPriceCents
    && change.supplier.taxCents === supplier.taxCents && change.supplier.freightCents === supplier.freightCents && change.supplier.leadTimeDays === supplier.leadTimeDays;
}

export async function startLineChange(db: Db, sessionId: string, key: CaseKey, input: { itemId: string; supplier?: SupplierConfirmation }): Promise<{ draft: ChangeDraft }> {
  if (!UUID.test(sessionId)) throw new PricingStoreError("INVALID_INPUT", "Open this project from the browser that owns the demo case.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
    if (!row) throw new PricingStoreError("PRICING_NOT_FOUND", "This demo project has not started yet.");
    if (row.activeRunId) throw new PricingStoreError("PRICING_BUSY", "Wait for the current AI reply before changing a line.");
    const quote = await currentCaseQuote(tx, row.id, key);
    if (!quote) throw new PricingStoreError("PRICING_NOT_READY", "The client has not approved any line yet. A change starts from an approved line.");
    const line = quote.lines.find((candidate) => candidate.itemId === input.itemId);
    if (!line) throw new PricingStoreError("PRICING_NOT_FOUND", "This line is not part of the current agreement.");

    const { supplier } = input;
    const differences = supplier ? supplierDifferences(line, supplier) : [];
    if (supplier && !differences.length) throw new PricingStoreError("INVALID_INPUT", "The supplier confirmed the approved terms. Save the supplier confirmation instead of starting a new version.");

    const fingerprint = quoteFingerprint(quote);
    const current = row.draft && row.draft.basedOnQuoteId === quote.id && row.draft.basedOnVersion === quote.version && row.draft.basedOnQuoteFingerprint === fingerprint ? row.draft : null;
    const started = current?.changes.find((change) => change.itemId === line.itemId);
    if (started) {
      // Asking again for the same change opens it; other terms would overwrite what the designer may have edited.
      if (!supplier || sameSupplier(started, supplier)) return { draft: current! };
      throw new PricingStoreError("PRICING_CONFLICT", "This item already has a change in the studio's draft. Edit it on the pricing page.");
    }
    const now = new Date().toISOString();
    const base: ChangeDraft = current ?? {
      id: randomUUID(), projectKey: key, basedOnQuoteId: quote.id, basedOnVersion: quote.version, basedOnQuoteFingerprint: fingerprint,
      revision: 0, status: "needs_designer_review", title: supplier ? "Updated supplier terms" : "Changes from the studio",
      summary: supplier
        ? "A supplier's order confirmation differs from the approved line. The client confirms the new terms in a new version before any money moves."
        : "Lines the designer changed on the current agreement, for example after a supplier's price notice. The client confirms them in a new version before any money moves.",
      changes: [], sourceMessageIds: [], sources: [], unresolved: [], constraints: [], deltaSubtotalCents: 0, createdAt: now, updatedAt: now, model: "designer",
    };
    const changes = [...base.changes, supplier ? supplierChange(line, supplier) : lineChange(line)];
    let draft: ChangeDraft = { ...base, changes, deltaSubtotalCents: changes.every((change) => change.deltaSubtotalCents !== null) ? changes.reduce((total, change) => total + change.deltaSubtotalCents!, 0) : null, revision: base.revision + 1, updatedAt: now };
    // The supplier's notice is the version's reason, unless the draft already stands on another one; the line's price evidence still cites the confirmation.
    if (supplier && (!current || current.supplierNotice)) {
      const lead = supplier.leadTimeDays !== null && supplier.leadTimeDays !== line.leadTimeDays ? `; lead time ${supplier.leadTimeDays} days` : "";
      const notice = `${line.vendor} order confirmation ${supplier.reference} for ${line.name}: ${differences.join(", ")}${lead}.`;
      const previous = current?.supplierNotice;
      draft = { ...draft, supplierNotice: previous
        ? { vendor: previous.vendor.split(", ").includes(line.vendor) ? previous.vendor : `${previous.vendor}, ${line.vendor}`, notice: `${previous.notice}\n${notice}` }
        : { vendor: line.vendor, notice } };
    }
    // While V1 stays open, every undecided V1 line comes along, as for any new version.
    draft = withV1Lines(draft, await readOpening(tx, row));
    await tx.update(chatCases).set({ draft, updatedAt: new Date() }).where(eq(chatCases.id, row.id));
    return { draft };
  });
}
