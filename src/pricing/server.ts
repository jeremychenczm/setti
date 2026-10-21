import { createDb } from "@/db/client";
import { createPricingStore } from "./store";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function pricingStore() {
  database.settiChatDatabase ??= createDb();
  return createPricingStore(database.settiChatDatabase.db);
}
