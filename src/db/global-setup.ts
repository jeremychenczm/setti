/**
 * Vitest global setup: brings the test database to the latest migration once,
 * before any test file runs. Skipped when TEST_DATABASE_URL is not set, except
 * in CI, where skipped database tests would make a passing run meaningless.
 */
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export default async function setup() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    if (process.env.CI) throw new Error("TEST_DATABASE_URL is not set in CI, so the database tests would be skipped.");
    return;
  }

  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}
