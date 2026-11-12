/**
 * Each real account's AI allowance: AI_REQUESTS_PER_ACCOUNT requests in all, counted
 * in the database so a restart does not reset it. A request is one @Setti reply or one
 * inbox summary, including its one checked rewrite. The demo's visitors keep the
 * hourly budget in ai-budget.ts instead.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import type { Actor } from "@/http/identity";
import { aiAllowances } from "./schema";

export const AI_REQUESTS_PER_ACCOUNT = 20;
export const AI_ALLOWANCE_USED = `This account has used its ${AI_REQUESTS_PER_ACCOUNT} AI requests. Your message is saved, and the rest of Setti keeps working.`;

/** Takes one request from the account's allowance; false when none is left. One statement, so requests at the same moment cannot overspend it. */
export async function takeAiAllowance(db: Db, actor: Pick<Actor, "userId" | "demoPersona">): Promise<boolean> {
  if (actor.demoPersona) return true;
  const taken = await db.insert(aiAllowances).values({ userId: actor.userId, used: 1 })
    .onConflictDoUpdate({
      target: aiAllowances.userId,
      set: { used: sql`${aiAllowances.used} + 1`, updatedAt: sql`now()` },
      setWhere: sql`${aiAllowances.used} < ${AI_REQUESTS_PER_ACCOUNT}`,
    })
    .returning({ used: aiAllowances.used });
  return taken.length > 0;
}
