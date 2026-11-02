/**
 * A demo session's simulated time. Skipping ahead moves the session's clock
 * forward one day at a time and runs the daily check for each day, as if the
 * days had passed: the notice on day 22, the renewal on day 25. PayPal calls
 * still happen now, in the Sandbox. The clock never goes back; ending the demo
 * starts a new session at day 0.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { runDailyCheck, type DailyCheckResult } from "../payments/daily-check";
import type { PayPalPayments } from "../payments/paypal";
import { demoDays, demoNow } from "./demo-time";
import { demoClocks } from "./schema";

export const MAX_SKIP_DAYS = 30;
export { demoDays, demoNow } from "./demo-time";

export class DemoClockError extends Error {
  constructor(message: string) { super(message); this.name = "DemoClockError"; }
}

/** Moves the session's clock forward to `toDays`, running the daily check for each day it passes. */
export async function skipAhead(db: Db, paypal: PayPalPayments, sessionId: string, toDays: number): Promise<{ days: number; runs: DailyCheckResult[] }> {
  if (!Number.isSafeInteger(toDays) || toDays < 1 || toDays > MAX_SKIP_DAYS) throw new DemoClockError(`Skip ahead by whole days, up to day ${MAX_SKIP_DAYS}.`);
  const from = await demoDays(db, sessionId);
  const runs: DailyCheckResult[] = [];
  for (let day = from + 1; day <= toDays; day += 1) {
    runs.push(await runDailyCheck(db, paypal, { now: demoNow(day), sessionId }));
    // The day counts once its check ran; a later day never moves the clock back.
    await db.insert(demoClocks).values({ sessionId, days: day })
      .onConflictDoUpdate({ target: demoClocks.sessionId, set: { days: sql`GREATEST(${demoClocks.days}, ${day})`, updatedAt: new Date() } });
  }
  return { days: Math.max(from, toDays), runs };
}
