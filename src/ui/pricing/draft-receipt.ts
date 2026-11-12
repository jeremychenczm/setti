import { orderedUnits, requiresOldItemHandling } from "@/pricing/calculation";
import type { PricingInput, PricingPreview, PricingWorkspace } from "@/pricing/types";
import { RECEIPT_FORMAT, RECEIPT_NOT_INCLUDED, type ChangeReceiptLine, type ReceiptItem, type VersionReceipt } from "@/receipts/types";
import { calculateLineTotals, calculateQuoteTotals } from "@/quotes/totals";

interface Priced { name: string; vendor: string; sku: string; quantity: number; unitLabel?: string; unitPriceCents: number | null; taxCents: number | null; freightCents: number | null }

function item(itemId: string, line: Priced): ReceiptItem {
  let totalCents = 0;
  if (line.unitPriceCents !== null) {
    try { totalCents = calculateLineTotals({ quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents ?? 0, freightCents: line.freightCents ?? 0 }).totalCents; }
    catch { totalCents = 0; }
  }
  return { itemId, name: line.name, vendor: line.vendor, sku: line.sku, quantity: line.quantity, unitLabel: line.unitLabel ?? "each", totalCents };
}

/**
 * The quote the client would receive if the designer sent the open draft now,
 * built from the editor's own state so Preview needs no save. It has no
 * fingerprint, signature or payment: those come with sending it.
 */
export function draftReceipt({ workspace, input, preview, nextVersion, clientName }: {
  workspace: PricingWorkspace; input: PricingInput; preview: PricingPreview | null; nextVersion: number; clientName: string;
}): VersionReceipt {
  const { quote } = workspace;
  const touched = new Set(input.changes.map((change) => change.itemId).filter(Boolean));
  const sorted = orderedUnits(input.changes.map((change) => ({ token: change.itemId ?? change.key, change })), input.lineOrder).map((unit) => unit.change);
  const changes: ChangeReceiptLine[] = sorted.map((change) => {
    const before = change.itemId ? quote.lines.find((line) => line.itemId === change.itemId) : undefined;
    return {
      itemId: change.itemId, action: change.action,
      before: before ? item(before.itemId, before) : null,
      after: change.after ? item(change.itemId ?? `new-${change.key}`, change.after) : null,
      oldItem: requiresOldItemHandling(change, before) ? {
        handling: change.oldItemHandling, retainedCents: change.oldItemCostCents ?? 0,
        fees: change.oldItemFees.flatMap((fee) => fee.amountCents === null ? [] : [{ kind: fee.kind, amountCents: fee.amountCents }]), note: change.oldItemNote,
      } : null,
    };
  });
  const previousCents = calculateQuoteTotals(quote.lines).totalCents;
  const totalCents = preview?.proposedTotals?.totalCents ?? previousCents;
  return {
    format: RECEIPT_FORMAT,
    receiptNo: `${workspace.projectKey.toUpperCase()}-V${nextVersion}-DRAFT`,
    issuedAt: new Date().toISOString(),
    project: { key: workspace.projectKey, name: quote.projectName, room: quote.room, client: clientName, designer: quote.designerName.replace(/\s*\(demo designer\)$/, "") },
    version: {
      number: nextVersion, basedOn: quote.version, status: "draft", replacedBy: null, sentAt: null, sentBy: null, contentHash: null,
      // Only the number of changes is read from it, for the document's title.
      document: { changes: input.changes } as unknown as VersionReceipt["version"]["document"],
      revision: null,
    },
    signatures: [],
    agreement: {
      kind: "change", changes,
      unchanged: orderedUnits(quote.lines.filter((line) => !touched.has(line.itemId)).map((line) => ({ token: line.itemId, line })), input.lineOrder).map(({ line }) => item(line.itemId, line)),
      source: { kind: input.source?.kind ?? null, vendor: input.source?.kind === "vendor" ? input.source.vendor : "", notice: input.source?.kind === "vendor" ? input.source.notice : "", messages: [] },
      terms: input.terms,
    },
    totals: { previousCents, totalCents, differenceCents: totalCents - previousCents },
    payments: [], pending: null, notIncluded: RECEIPT_NOT_INCLUDED,
  };
}
