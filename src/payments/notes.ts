import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items } from "../db/schema";
import { chatMessages } from "../chat/schema";
import { changeOrders } from "../pricing/schema";

type Writer = Pick<Db, "select" | "insert">;

/**
 * Adds a money event to the project conversation, so the case timeline shows
 * which version and item each PayPal result belongs to. Only operations bound to
 * a change order have a conversation.
 */
export async function noteInCase(tx: Writer, operation: { changeOrderId: string | null; itemId: string | null }, text: (context: { version: number; itemName: string }) => string): Promise<void> {
  if (!operation.changeOrderId || !operation.itemId) return;
  const [order] = await tx.select({ caseId: changeOrders.caseId, document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId));
  const [item] = await tx.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId));
  if (!order || !item) return;
  await tx.insert(chatMessages).values({ caseId: order.caseId, id: randomUUID(), actor: "assistant", model: "system", aiState: "completed", text: text({ version: order.document.version, itemName: item.name }) });
}
