/**
 * Helpers for tests that need a real database. They run only when
 * TEST_DATABASE_URL is set (see .env.example), so `npm test` still works
 * without Docker. Migrations are applied once in the global setup.
 */
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Connects to the test database (already migrated by the global setup). */
export async function openTestDb() {
  return createDb(testDatabaseUrl);
}

/** Empties the given tables so each test starts from a clean state. */
export async function truncate(db: ReturnType<typeof createDb>["db"], ...tables: string[]) {
  await db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
}
