import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, revisions } from "../db/schema";
import { chatMessages } from "../chat/schema";
import { changeOrders, pricingCases } from "../pricing/schema";

type Writer = Pick<Db, "select" | "insert">;

/**
 * Adds a money event to the project conversation, so the case timeline shows
 * which version and item each PayPal result belongs to. Only operations bound to
 * a change order or to a signed V1 have a conversation.
 */
export async function noteInCase(tx: Writer, operation: { changeOrderId: string | null; revisionId?: string | null; itemId: string | null; servicesHold?: boolean }, text: (context: { version: number; itemName: string }) => string): Promise<void> {
  if (!operation.itemId && !operation.servicesHold) return;
  const [scope] = operation.changeOrderId
    ? (await tx.select({ caseId: changeOrders.caseId, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId)))
      .map((order) => ({ caseId: order.caseId, version: order.document.version }))
    : operation.revisionId
      ? await tx.select({ caseId: pricingCases.caseId, version: revisions.number }).from(pricingCases)
        .innerJoin(revisions, eq(revisions.id, pricingCases.baselineRevisionId)).where(eq(pricingCases.baselineRevisionId, operation.revisionId))
      : [];
  const [item] = operation.itemId ? await tx.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId)) : [{ name: "Design services" }];
  if (!scope || !item) return;
  await tx.insert(chatMessages).values({ caseId: scope.caseId, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text: text({ version: scope.version, itemName: item.name }) });
}
