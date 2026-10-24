import { createDb } from "@/db/client";
import { createPricingStore } from "./store";

const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function pricingDb() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}

export function pricingStore() {
  return createPricingStore(pricingDb());
}
