/** The studio and project a change order belongs to, so a route can tell who may act on it. */
import { eq } from "drizzle-orm";
import { chatCases } from "@/chat/schema";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { changeOrders } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChangeOrderOwner { studioId: string; key: CaseKey; version: number }

export async function changeOrderOwner(db: Pick<Db, "select">, id: string): Promise<ChangeOrderOwner | null> {
  if (!UUID.test(id)) return null;
  const [found] = await db.select({ studioId: chatCases.sessionId, key: chatCases.projectKey, document: changeOrders.document }).from(changeOrders)
    .innerJoin(chatCases, eq(changeOrders.caseId, chatCases.id)).where(eq(changeOrders.id, id));
  return found ? { studioId: found.studioId, key: found.key, version: found.document.version } : null;
}
