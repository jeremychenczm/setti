import { createDb } from "@/db/client";
import { createOpeningStore } from "./store";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function openingStore() {
  database.settiChatDatabase ??= createDb();
  return createOpeningStore(database.settiChatDatabase.db);
}
