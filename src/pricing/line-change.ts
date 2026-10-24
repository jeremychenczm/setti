/**
 * The designer starts a change on a line of the current agreement, for example
 * after a supplier's price notice: the same product with another price,
 * quantity or terms. It enters the case's draft (the current one, or a new
 * designer draft) and is reviewed on the pricing page like any draft line, so
 * the client confirms it in a new version before any money moves.
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
import { PricingStoreError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The line as it stands, as both sides of a change the designer then edits. */
function lineChange(line: ApprovedQuoteLine): DraftChange {
  const item = { name: line.name, vendor: line.vendor, brand: null, sku: line.sku, specification: line.specification, quantity: line.quantity, unitLabel: line.unitLabel ?? "each", unitPriceCents: line.unitPriceCents, currency: "USD" };
  const subtotal = line.quantity * line.unitPriceCents;
  return { action: "quantity", itemId: line.itemId, before: item, after: { ...item }, productOptionId: null, sourceMessageIds: [], beforeSubtotalCents: subtotal, afterSubtotalCents: subtotal, deltaSubtotalCents: 0 };
}

export async function startLineChange(db: Db, sessionId: string, key: CaseKey, input: { itemId: string }): Promise<{ draft: ChangeDraft }> {
  if (!UUID.test(sessionId)) throw new PricingStoreError("INVALID_INPUT", "Open this project from the browser that owns the demo case.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
    if (!row) throw new PricingStoreError("PRICING_NOT_FOUND", "This demo project has not started yet.");
    if (row.activeRunId) throw new PricingStoreError("PRICING_BUSY", "Wait for the current AI reply before changing a line.");
    const quote = await currentCaseQuote(tx, row.id, key);
    if (!quote) throw new PricingStoreError("PRICING_NOT_READY", "The client has not approved any line yet. A change starts from an approved line.");
    const line = quote.lines.find((candidate) => candidate.itemId === input.itemId);
    if (!line) throw new PricingStoreError("PRICING_NOT_FOUND", "This line is not part of the current agreement.");

    const fingerprint = quoteFingerprint(quote);
    const current = row.draft && row.draft.basedOnQuoteId === quote.id && row.draft.basedOnVersion === quote.version && row.draft.basedOnQuoteFingerprint === fingerprint ? row.draft : null;
    if (current?.changes.some((change) => change.itemId === line.itemId)) return { draft: current };
    const now = new Date().toISOString();
    const base: ChangeDraft = current ?? {
      id: randomUUID(), projectKey: key, basedOnQuoteId: quote.id, basedOnVersion: quote.version, basedOnQuoteFingerprint: fingerprint,
      revision: 0, status: "needs_designer_review", title: "Changes from the studio",
      summary: "Lines the designer changed on the current agreement, for example after a supplier's price notice. The client confirms them in a new version before any money moves.",
      changes: [], sourceMessageIds: [], sources: [], unresolved: [], constraints: [], deltaSubtotalCents: 0, createdAt: now, updatedAt: now, model: "designer",
    };
    const changes = [...base.changes, lineChange(line)];
    let draft: ChangeDraft = { ...base, changes, deltaSubtotalCents: changes.every((change) => change.deltaSubtotalCents !== null) ? changes.reduce((total, change) => total + change.deltaSubtotalCents!, 0) : null, revision: base.revision + 1, updatedAt: now };
    // While V1 stays open, every undecided V1 line comes along, as for any new version.
    draft = withV1Lines(draft, await readOpening(tx, row));
    await tx.update(chatCases).set({ draft, updatedAt: new Date() }).where(eq(chatCases.id, row.id));
    return { draft };
  });
}
