/**
 * Moves a saved pricing review onto a newer draft. Three plain records are
 * compared field by field: what the draft proposed when the review was saved,
 * what the designer saved, and what the draft proposes now. A field only the
 * draft changed takes the new proposal; a field only the designer changed keeps
 * the designer's value; a field both changed waits for the designer to choose.
 */
import { canonical } from "@/quotes/fingerprint";
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { FieldChange } from "./review-diff";
import type { PricingChangeInput, PricingInput, PricingItem } from "./types";

export interface CarryOverConflict {
  /** The line's key in the carried input. */
  key: string;
  name: string;
  /** The line with the designer's values in the contested fields, as it stands in the carried input until a choice is made. */
  mine: PricingChangeInput;
  /** The same line with the newer draft's values in those fields. */
  latest: PricingChangeInput;
  /** The contested fields: the designer's value before, the draft's after. */
  changes: FieldChange[];
}

export interface ReviewCarryOver {
  /** The saved review on the current draft. Not saved until the designer saves it. */
  input: PricingInput;
  /** Lines that took the newer draft's changes, with any of the designer's other edits kept. */
  updated: string[];
  /** Lines the designer edited and the draft left alone: the edits stay. */
  kept: string[];
  added: string[];
  removed: string[];
  conflicts: CarryOverConflict[];
}

const money = (cents: unknown) => typeof cents === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100) : "not set";
const ITEM_FIELDS: Record<keyof PricingItem, [string, (value: unknown) => string]> = {
  name: ["Name", String], vendor: ["Supplier", String], brand: ["Brand", String], sku: ["SKU", String], specification: ["Specification", String],
  category: ["Category", String], room: ["Room", String], quantity: ["Quantity", String], unitLabel: ["Purchase unit", String], currency: ["Currency", String],
  unitPriceCents: ["Unit price", money], taxCents: ["Tax", money], freightCents: ["Delivery", money], sourceUrl: ["Source link", String],
  returnPolicy: ["Return terms", String], returnable: ["Returns", (value) => value === null ? "to be confirmed" : value ? "returnable" : "not returnable"],
  restockingFeeBps: ["Restocking fee", (value) => typeof value === "number" ? `${value / 100}%` : "not set"], customMade: ["Custom made", (value) => value ? "yes" : "no"],
  leadTimeDays: ["Lead time", (value) => typeof value === "number" ? `${value} days` : "not set"],
};
const LINE_FIELDS = { priceEvidence: ["Price evidence", String], oldItemHandling: ["Old item handling", String], oldItemCostCents: ["Old item cost", money], oldItemNote: ["Old item note", String] } satisfies Partial<Record<keyof PricingChangeInput, [string, (value: unknown) => string]>>;
type LineField = keyof typeof LINE_FIELDS;

/** A line is the same line across drafts when it targets the same V1 or quote item the same way. */
function identities(changes: PricingChangeInput[]): string[] {
  const seen = new Map<string, number>();
  return changes.map((change) => {
    const id = change.fromV1 ? `v1:${change.fromV1.kind}:${change.fromV1.itemId}` : change.itemId ? `${change.action}:${change.itemId}` : `add:${change.after?.name.trim().toLowerCase() ?? ""}`;
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return `${id}#${count}`;
  });
}

const same = (left: unknown, right: unknown) => canonical(left ?? null) === canonical(right ?? null);
const display = (value: unknown, format: (value: unknown) => string) => value === null || value === undefined || value === "" ? "not set" : format(value);

type Merged = { line: PricingChangeInput; latest: PricingChangeInput; contested: FieldChange[]; tookDraft: boolean; keptMine: boolean };

/** One line, field by field. Fields the draft fixes (action, item, V1 origin) always come from the newer draft. */
function mergeLine(base: PricingChangeInput, mine: PricingChangeInput, next: PricingChangeInput): Merged {
  const line = structuredClone(next);
  const latest = structuredClone(next);
  const contested: FieldChange[] = [];
  let tookDraft = false;
  let keptMine = false;
  function merge(before: unknown, own: unknown, proposed: unknown, label: string, format: (value: unknown) => string, assign: (target: PricingChangeInput, value: unknown) => void) {
    const edited = !same(own, before);
    if (!same(proposed, before)) {
      if (!edited || same(own, proposed)) { if (!same(own, proposed)) tookDraft = true; return; }
      contested.push({ label, before: display(own, format), after: display(proposed, format) });
      assign(line, own);
      return;
    }
    if (edited) keptMine = true;
    assign(line, own);
    assign(latest, own);
  }
  if (line.after && latest.after && base.after && mine.after) {
    for (const [field, [label, format]] of Object.entries(ITEM_FIELDS) as [keyof PricingItem, [string, (value: unknown) => string]][]) {
      merge(base.after[field], mine.after[field], next.after![field], label, format, (target, value) => { (target.after as unknown as Record<string, unknown>)[field] = value; });
    }
  }
  for (const [field, [label, format]] of Object.entries(LINE_FIELDS) as [LineField, [string, (value: unknown) => string]][]) {
    merge(base[field], mine[field], next[field], label, format, (target, value) => { (target as unknown as Record<string, unknown>)[field] = value; });
  }
  // The designer's check stands only for a line whose values it covered.
  const confirmed = mine.confirmed && !tookDraft && !contested.length;
  return { line: { ...line, confirmed }, latest: { ...latest, confirmed: false }, contested, tookDraft, keptMine };
}

export function carryOverReview(quote: ApprovedQuoteReport, proposed: PricingInput, saved: PricingInput, latest: PricingInput): ReviewCarryOver {
  const nameOf = (change: PricingChangeInput) => change.after?.name || quote.lines.find((line) => line.itemId === change.itemId)?.name || "Line";
  const proposedIds = identities(proposed.changes);
  const earlier = new Map(proposed.changes.map((proposal, index) => [proposedIds[index], { proposal, saved: saved.changes.find((change) => change.key === proposal.key) ?? proposal }]));
  const latestIds = identities(latest.changes);
  const result: Omit<ReviewCarryOver, "input"> = { updated: [], kept: [], added: [], removed: [], conflicts: [] };

  const changes = latest.changes.map((next, index) => {
    const before = earlier.get(latestIds[index]);
    if (!before) {
      result.added.push(nameOf(next));
      return next;
    }
    const merged = mergeLine(before.proposal, before.saved, next);
    const name = nameOf(merged.line);
    if (merged.contested.length) result.conflicts.push({ key: next.key, name, mine: merged.line, latest: merged.latest, changes: merged.contested });
    else if (merged.tookDraft) result.updated.push(name);
    else if (merged.keptMine) result.kept.push(name);
    return merged.line;
  });
  const still = new Set(latestIds);
  for (const id of proposedIds) if (!still.has(id)) result.removed.push(nameOf(earlier.get(id)!.saved));

  const issues = latest.issues.map((issue) => {
    const answered = saved.issues.find((entry) => entry.label === issue.label);
    return answered ? { ...issue, resolved: answered.resolved, note: answered.note } : issue;
  });
  return {
    ...result,
    input: { ...latest, title: saved.title !== proposed.title ? saved.title : latest.title, terms: saved.terms, reviewNotes: saved.reviewNotes, changes, issues },
  };
}
