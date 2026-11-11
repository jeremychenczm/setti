/** The one database pool the app's routes and pages share, across hot reloads. */
import { createDb } from "./client";

const shared = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };

export function appDb() {
  shared.settiChatDatabase ??= createDb();
  return shared.settiChatDatabase.db;
}
