import { createDb } from "@/db/client";
import { createChatStore } from "./store";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function chatStore() {
  database.settiChatDatabase ??= createDb();
  return createChatStore(database.settiChatDatabase.db);
}
