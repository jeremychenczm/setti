/**
 * What a saved pricing review changes, field by field: each line's values as
 * they stand in the approved quote (or in V1, for a line that comes back from
 * it) against the values the designer saved. A plain comparison of the saved
 * records; nothing is inferred.
 */
import type { FromV1 } from "@/chat/types";
import type { QuoteLine } from "@/quotes/types";
import type { PricingChangeInput, PricingItem, PricingWorkspace } from "./types";

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

export interface ReviewLine {
  key: string;
  name: string;
  /** How the line enters the new version. */
  kind: "revised" | "carried" | "changed" | "added" | "removed";
  fromV1?: FromV1;
  /** For a revised, carried or changed line: only the fields that differ. For an added line: its main values. */
  changes: FieldChange[];
  confirmed: boolean;
}

export interface ReviewSummary {
  version: number;
  /** The draft changed after this review was saved, so it describes an older draft. */
  stale: boolean;
  confirmed: number;
  lines: ReviewLine[];
  baselineTotalCents: number;
  proposedTotalCents: number | null;
  deltaCents: number | null;
  ready: boolean;
}

const money = (cents: number | null | undefined) => cents === null || cents === undefined ? "not set" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const text = (value: string | null | undefined) => value?.trim() ? value.trim() : "not set";
const returnability = (returnable: boolean | null) => returnable === null ? "to be confirmed" : returnable ? "returnable" : "not returnable";

/** The comparable fields of a line, in reading order. */
function fieldsOfLine(line: QuoteLine): [string, string][] {
  return [
    ["Name", line.name], ["Supplier", line.vendor], ["SKU", line.sku], ["Specification", line.specification], ["Room", line.room],
    ["Quantity", `${line.quantity} ${line.unitLabel ?? "each"}`], ["Unit price", money(line.unitPriceCents)], ["Tax", money(line.taxCents)],
    ["Delivery", money(line.freightCents)], ["Return terms", line.returnPolicy], ["Returns", returnability(line.nonReturnable === null ? null : !line.nonReturnable)],
  ];
}

function fieldsOfItem(item: PricingItem): [string, string][] {
  return [
    ["Name", text(item.name)], ["Supplier", text(item.vendor)], ["SKU", text(item.sku)], ["Specification", text(item.specification)], ["Room", text(item.room)],
    ["Quantity", `${item.quantity} ${item.unitLabel || "each"}`], ["Unit price", money(item.unitPriceCents)], ["Tax", money(item.taxCents)],
    ["Delivery", money(item.freightCents)], ["Return terms", text(item.returnPolicy)], ["Returns", returnability(item.returnable)],
  ];
}

/** The fields of a line that differ from the quote line it started from. */
export function differences(before: QuoteLine, after: PricingItem): FieldChange[] {
  const old = fieldsOfLine(before);
  return fieldsOfItem(after).flatMap(([label, value], index) => value === old[index][1] ? [] : [{ label, before: old[index][1], after: value }]);
}

function lineOf(workspace: PricingWorkspace, change: PricingChangeInput, index: number): ReviewLine {
  const draftChange = workspace.sourceDraft?.changes[index];
  const v1Line = draftChange?.fromV1?.line;
  const baseline = change.itemId ? workspace.quote.lines.find((line) => line.itemId === change.itemId) : undefined;
  const name = change.after?.name || baseline?.name || v1Line?.name || "Line";
  const common = { key: change.key, name, confirmed: change.confirmed, ...(change.fromV1 ? { fromV1: change.fromV1 } : {}) };
  if (!change.after) return { ...common, kind: "removed", changes: baseline ? [{ label: "Line", before: `${baseline.quantity} × ${money(baseline.unitPriceCents)}`, after: "removed" }] : [] };
  const before = v1Line ?? baseline;
  if (!before) {
    return { ...common, kind: "added", changes: fieldsOfItem(change.after).filter(([label]) => ["Supplier", "Quantity", "Unit price", "Tax", "Delivery"].includes(label)).map(([label, value]) => ({ label, before: "—", after: value })) };
  }
  return { ...common, kind: change.fromV1?.kind ?? "changed", changes: differences(before, change.after) };
}

/** Null until a review is saved: the panel then shows the draft as proposed. */
export function reviewSummary(workspace: PricingWorkspace): ReviewSummary | null {
  const review = workspace.review;
  if (!review || review.version < 1) return null;
  const stale = workspace.stale || !workspace.sourceDraft || review.sourceDraftId !== workspace.sourceDraft.id || review.sourceDraftRevision !== workspace.sourceDraft.revision;
  const lines = stale ? [] : review.input.changes.map((change, index) => lineOf(workspace, change, index));
  const preview = workspace.preview;
  return {
    version: review.version, stale, lines, confirmed: review.input.changes.filter((change) => change.confirmed).length,
    baselineTotalCents: preview?.baselineTotals.totalCents ?? 0, proposedTotalCents: preview?.proposedTotals?.totalCents ?? null,
    deltaCents: preview?.deltaTotalCents ?? null, ready: !stale && !!preview?.ready,
  };
}
