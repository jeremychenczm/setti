/**
 * V1 lines a new version brings back. A declined line the designer revises,
 * and every line the client has not decided on yet, enter the draft as added
 * lines that remember where they came from. Issuing that version closes V1,
 * so nothing undecided is left behind.
 */
import type { ChangeDraft, DraftChange, FromV1 } from "../chat/types";
import type { QuoteLine } from "../quotes/types";
import type { OpeningRead } from "./read";

export function v1Change(line: QuoteLine, kind: FromV1["kind"], reason: string | null): DraftChange {
  const subtotal = line.quantity * line.unitPriceCents;
  return {
    action: "add", itemId: null, before: null,
    after: { name: line.name, vendor: line.vendor, brand: null, sku: line.sku, specification: line.specification, quantity: line.quantity, unitLabel: line.unitLabel ?? "each", unitPriceCents: line.unitPriceCents, currency: "USD" },
    productOptionId: null, sourceMessageIds: [], beforeSubtotalCents: null, afterSubtotalCents: subtotal, deltaSubtotalCents: subtotal,
    fromV1: { itemId: line.itemId, kind, reason, line: structuredClone(line) },
  };
}

function deltaOf(changes: DraftChange[]): number | null {
  return changes.every((change) => change.deltaSubtotalCents !== null) ? changes.reduce((total, change) => total + change.deltaSubtotalCents!, 0) : null;
}

/**
 * Keeps a draft in step with V1: revised lines stay only while their V1 line is
 * still declined, and every undecided V1 line is carried. Returns the same draft
 * when nothing changed.
 */
export function withV1Lines(draft: ChangeDraft, read: OpeningRead): ChangeDraft {
  if (!read.opening.sentAt || read.opening.closed) return draft;
  const kept = draft.changes.filter((change) => !change.fromV1
    || (change.fromV1.kind === "revised" ? read.lines[change.fromV1.itemId]?.state === "declined" : read.lines[change.fromV1.itemId]?.state === "pending"));
  const carried = new Set(kept.flatMap((change) => change.fromV1?.kind === "carried" ? [change.fromV1.itemId] : []));
  const added = read.document.lines.filter((line) => read.lines[line.itemId].state === "pending" && !carried.has(line.itemId)).map((line) => v1Change(line, "carried", null));
  if (!added.length && kept.length === draft.changes.length) return draft;
  const changes = [...kept, ...added];
  return { ...draft, changes, deltaSubtotalCents: deltaOf(changes), revision: draft.revision + 1, updatedAt: new Date().toISOString() };
}

/** Adds a revision of a declined V1 line to a draft that does not have one yet. */
export function withRevisedLine(draft: ChangeDraft, line: QuoteLine, reason: string | null): ChangeDraft {
  if (draft.changes.some((change) => change.fromV1?.kind === "revised" && change.fromV1.itemId === line.itemId)) return draft;
  const changes = [...draft.changes, v1Change(line, "revised", reason)];
  return { ...draft, changes, deltaSubtotalCents: deltaOf(changes), revision: draft.revision + 1, updatedAt: new Date().toISOString() };
}
