/**
 * The designer writes a project's V1 before sending it. The whole draft is saved
 * at once, against the draft it was edited from, and only while V1 is unsent.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { chatCases } from "@/chat/schema";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { documentHash, withoutApproval } from "@/opening/document";
import { openingQuotes } from "@/opening/schema";
import type { QuoteDocument, QuoteLine } from "@/quotes/types";
import { sentFromChat } from "./settings";

export const DRAFT_LINES_MAX = 200;
const cents = z.number().int().min(0).max(2_000_000_000);
const text = (max: number) => z.string().trim().max(max);

const lineSchema = z.strictObject({
  /** The line's id when it was saved before; a new line gets one from the server. */
  itemId: z.string().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(160),
  category: z.enum(["furniture", "service"]),
  vendor: text(120),
  room: text(120),
  sku: text(80),
  specification: text(2_000),
  quantity: z.number().int().min(1).max(100_000),
  unitLabel: text(30),
  unitPriceCents: cents,
  taxCents: cents,
  freightCents: cents,
  /** Null: not known yet, or not applicable. */
  leadTimeDays: z.number().int().min(0).max(3_650).nullable(),
  returnPolicy: text(1_000),
  /** Basis points; null: the fee is not confirmed yet. */
  restockingFeeBps: z.number().int().min(0).max(10_000).nullable(),
  customMade: z.boolean(),
  /** Null: whether it can be returned still needs review. */
  nonReturnable: z.boolean().nullable(),
  sourceUrl: z.url({ protocol: /^https?$/ }).max(500).nullable(),
});

export const draftSchema = z.strictObject({
  /** The draft the designer edited, as its hash: a save over a newer draft is refused. */
  basedOn: z.string().regex(/^[0-9a-f]{64}$/),
  room: text(120),
  clientName: text(120),
  lines: z.array(lineSchema).max(DRAFT_LINES_MAX),
});
export type DraftInput = z.infer<typeof draftSchema>;

export class DraftError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_AVAILABLE" | "STALE_DRAFT", message: string) { super(message); }
}

function line(key: CaseKey, input: DraftInput["lines"][number], itemId: string): QuoteLine {
  return {
    itemId, name: input.name, vendor: input.vendor, category: input.category, room: input.room, sku: input.sku,
    specification: input.specification, quantity: input.quantity, unitPriceCents: input.unitPriceCents,
    ...(input.unitLabel ? { unitLabel: input.unitLabel } : {}),
    taxCents: input.taxCents, freightCents: input.freightCents,
    source: input.sourceUrl
      ? { kind: "public_reference", reference: `${key}:${itemId}`, name: input.vendor || "Supplier page", note: "Price entered by the designer from the supplier's page.", url: input.sourceUrl }
      : { kind: "estimate", reference: `${key}:${itemId}`, name: input.vendor || "Designer estimate", note: "Price entered by the designer." },
    leadTimeDays: input.leadTimeDays, returnPolicy: input.returnPolicy, restockingFeeBps: input.restockingFeeBps,
    customMade: input.customMade, nonReturnable: input.nonReturnable,
  };
}

/** Saves the draft V1 and returns it with its new hash, the `basedOn` of the next save. */
export async function saveDraft(db: Db, studioId: string, key: CaseKey, input: DraftInput): Promise<{ document: QuoteDocument; hash: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, studioId), eq(chatCases.projectKey, key))).for("update");
    if (!row) throw new DraftError("NOT_FOUND", "Project not found.");
    if (!sentFromChat(row)) throw new DraftError("NOT_AVAILABLE", "This project started from a quote approved before Setti; its V1 cannot be edited.");
    const [sent] = await tx.select({ caseId: openingQuotes.caseId }).from(openingQuotes).where(eq(openingQuotes.caseId, row.id));
    if (sent) throw new DraftError("NOT_AVAILABLE", "Quote V1 was sent to the client and is frozen. Changes now go through a new version.");
    const current = withoutApproval(row.quote);
    if (documentHash(current) !== input.basedOn) throw new DraftError("STALE_DRAFT", "Quote V1 was changed in another window. Reload it before saving.");
    // Lines keep their ids; a new line, or an id the draft does not have, gets a fresh one.
    const known = new Set(current.lines.map((entry) => entry.itemId));
    const used = new Set<string>();
    const lines = input.lines.map((entry) => {
      const itemId = entry.itemId && known.has(entry.itemId) && !used.has(entry.itemId) ? entry.itemId : `line-${randomUUID().slice(0, 8)}`;
      used.add(itemId);
      return line(key, entry, itemId);
    });
    const document: QuoteDocument = { ...current, room: input.room, clientName: input.clientName, lines };
    await tx.update(chatCases).set({ quote: document, updatedAt: new Date() }).where(eq(chatCases.id, row.id));
    return { document, hash: documentHash(document) };
  });
}
