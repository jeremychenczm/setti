/**
 * Runs the daily check once, against DATABASE_URL and the PayPal Sandbox:
 * `npm run holds:check`. Hosting calls POST /api/jobs/daily-check instead.
 */
import { existsSync } from "node:fs";
import { createDb } from "../src/db/client";
import { runDailyCheck } from "../src/payments/daily-check";
import { sandboxPayPal } from "../src/payments/server";

async function main() {
  const { db, pool } = createDb();
  try {
    const result = await runDailyCheck(db, sandboxPayPal());
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
void main();
