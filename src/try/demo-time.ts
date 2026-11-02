/**
 * Reading a demo session's simulated time: how many days it skipped ahead, and
 * the "now" Setti judges its holds by. Moving the clock is in clock.ts.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { demoClocks } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days the session has skipped ahead; 0 for a session that never did. */
export async function demoDays(db: Pick<Db, "select">, sessionId: string | null): Promise<number> {
  if (!sessionId) return 0;
  const [clock] = await db.select({ days: demoClocks.days }).from(demoClocks).where(eq(demoClocks.sessionId, sessionId));
  return clock?.days ?? 0;
}

/** The session's "now": real time plus the days it skipped ahead. */
export function demoNow(days: number, real = new Date()): Date {
  return new Date(real.getTime() + days * DAY_MS);
}
