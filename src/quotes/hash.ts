import { createHash } from "node:crypto";

/** The parts of a revision line the client agrees to. */
export interface LineSnapshot {
  itemId: string;
  quantity: number;
  unitPriceCents: number;
  taxCents: number;
  freightCents: number;
  restockingFeeBps: number | null;
  returnable: boolean | null;
  customMade: boolean;
  leadTimeDays: number | null;
}

/**
 * SHA-256 of a revision's lines. Lines are sorted and serialised in a fixed
 * field order, so the hash depends only on what the client agrees to.
 */
export function hashRevision(lines: LineSnapshot[]): string {
  const canonical = [...lines]
    .sort((a, b) => a.itemId.localeCompare(b.itemId))
    .map((l) => [
      l.itemId,
      l.quantity,
      l.unitPriceCents,
      l.taxCents,
      l.freightCents,
      l.restockingFeeBps,
      l.returnable,
      l.customMade,
      l.leadTimeDays,
    ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
