/**
 * Helpers for tests that need a real database. They run only when
 * TEST_DATABASE_URL is set (see .env.example), so `npm test` still works
 * without Docker.
 */
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Connects to the test database and brings it to the latest migration. */
export async function openTestDb() {
  const handle = createDb(testDatabaseUrl);
  await migrate(handle.db, { migrationsFolder: "drizzle" });
  return handle;
}

/** Empties the given tables so each test starts from a clean state. */
export async function truncate(db: ReturnType<typeof createDb>["db"], ...tables: string[]) {
  await db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
}
