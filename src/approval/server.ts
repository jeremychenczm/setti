import { createDb } from "@/db/client";
import { createApprovalStore } from "./store";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function approvalStore() {
  database.settiChatDatabase ??= createDb();
  return createApprovalStore(database.settiChatDatabase.db);
}
