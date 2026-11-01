/**
 * Runs the daily check once, against DATABASE_URL and the PayPal Sandbox:
 * `npm run holds:check`. Hosting calls POST /api/jobs/daily-check instead.
 *
 * `npm run holds:check -- --days 23` checks as if that many days had passed,
 * for testing renewal notices and renewals in the Sandbox without waiting. The
 * PayPal calls it makes are real Sandbox calls: renewals place new holds with
 * the client's saved payment method and void the old ones.
 */
import { existsSync } from "node:fs";
import { createDb } from "../src/db/client";
import { runDailyCheck } from "../src/payments/daily-check";
import { sandboxPayPal } from "../src/payments/server";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAhead(): number {
  const index = process.argv.indexOf("--days");
  if (index < 0) return 0;
  const days = Number(process.argv[index + 1]);
  if (!Number.isFinite(days) || days < 0 || days > 60) throw new Error("--days takes a number of days between 0 and 60.");
  return days;
}

async function main() {
  const days = daysAhead();
  const now = new Date(Date.now() + days * DAY_MS);
  if (days) console.log(`Checking as if it were ${now.toISOString()} (${days} days ahead).`);
  const { db, pool } = createDb();
  try {
    console.log(JSON.stringify(await runDailyCheck(db, sandboxPayPal(), { now }), null, 2));
  } finally {
    await pool.end();
  }
}

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
void main();
