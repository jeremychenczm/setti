import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { HOME_SCENARIO } from "../demo/living-dining";
import { trySeeds } from "./schema";

/** The project /try prepares in a demo studio. */
export const TRY_PROJECT_KEY = "maple";

export const PREPARATION_MESSAGE = "The starting payment records are still being prepared. You can discuss the project and review the draft; sending a version and payment actions will be available when preparation finishes.";

/**
 * Local bookkeeping only. While /try prepares a demo studio's V1 payment history,
 * actions on that project wait, so they cannot race it. Given no project, any
 * preparation of the studio counts.
 */
export async function paymentPreparationPending(db: Pick<Db, "select">, session: string, key?: string): Promise<boolean> {
  if (key !== undefined && key !== TRY_PROJECT_KEY) return false;
  const [seed] = await db.select({ status: trySeeds.status }).from(trySeeds).where(and(eq(trySeeds.sessionId, session), eq(trySeeds.scenario, HOME_SCENARIO)));
  return !!seed && seed.status !== "ready";
}
