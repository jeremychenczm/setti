/**
 * The business project behind a demo case: one project, its items and the
 * baseline revision that later versions are based on. Payments and versions
 * refer to these rows, never to the demo quote objects.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, projects, revisionLines, revisions } from "../db/schema";
import { hashRevision } from "../quotes/hash";
import type { QuoteDocument } from "../quotes/types";
import { itemMappingKey } from "./document";
import { PricingStoreError } from "./errors";
import { pricingCases } from "./schema";

export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Same freeze sequence as sendRevision, inside the caller's transaction rather than a nested one. */
export async function freezeRevision(tx: Transaction, revisionId: string): Promise<string> {
  const [revision] = await tx.select().from(revisions).where(eq(revisions.id, revisionId)).for("update");
  if (!revision || revision.status !== "draft") throw new PricingStoreError("PRICING_CONFLICT", "The business revision is no longer a draft.");
  const lines = await tx.select().from(revisionLines).where(eq(revisionLines.revisionId, revisionId));
  if (lines.length === 0) throw new PricingStoreError("PRICING_NOT_READY", "A change order must retain at least one quoted line.");
  const hash = hashRevision(lines);
  await tx.update(revisions).set({ status: "sent", contentHash: hash, sentAt: new Date() }).where(eq(revisions.id, revisionId));
  return hash;
}

export interface Baseline {
  bridge: typeof pricingCases.$inferSelect;
  revisionHash: string;
  /** Quote item id → revision line id of the baseline revision. */
  lineIds: Map<string, string>;
}

/**
 * Creates the case's business project with the quote as its sent baseline
 * revision. Approving it is the caller's decision: Maple imports its demo
 * approval, Willow waits for the client's signed line decisions.
 */
export async function insertBaseline(tx: Transaction, caseId: string, quote: QuoteDocument): Promise<Baseline> {
  const [project] = await tx.insert(projects).values({ name: `${quote.projectName} (demo pricing)`, space: quote.room, clientName: quote.clientName, currency: "USD" }).returning();
  const [revision] = await tx.insert(revisions).values({ projectId: project.id, number: quote.version }).returning();
  const itemMapping: Record<string, string> = {};
  const lineIds = new Map<string, string>();
  for (const line of quote.lines) {
    const [item] = await tx.insert(items).values({ projectId: project.id, name: line.name, vendor: line.vendor, kind: line.category, sourceUrl: line.source.url ?? null }).returning();
    itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })] = item.id;
    const [savedLine] = await tx.insert(revisionLines).values({
      revisionId: revision.id, itemId: item.id, quantity: line.quantity, unitPriceCents: line.unitPriceCents,
      taxCents: line.taxCents, freightCents: line.freightCents, restockingFeeBps: line.restockingFeeBps,
      returnable: line.nonReturnable === null ? null : !line.nonReturnable, customMade: line.customMade, leadTimeDays: line.leadTimeDays,
    }).returning();
    lineIds.set(line.itemId, savedLine.id);
  }
  const revisionHash = await freezeRevision(tx, revision.id);
  const [bridge] = await tx.insert(pricingCases).values({ caseId, projectId: project.id, baselineRevisionId: revision.id, baselineQuoteId: quote.id, itemMapping }).returning();
  return { bridge, revisionHash, lineIds };
}
