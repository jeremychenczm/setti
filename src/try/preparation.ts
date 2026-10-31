import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { HOME_SCENARIO } from "../demo/living-dining";
import { trySeeds } from "./schema";

export const PREPARATION_MESSAGE = "The starting payment records are still being prepared. You can discuss the project and review the draft; sending a version and payment actions will be available when preparation finishes.";

/** Local bookkeeping only. Public actions cannot race the prepared V1 payment history. */
export async function paymentPreparationPending(db: Pick<Db, "select">, session: string): Promise<boolean> {
  const [seed] = await db.select({ status: trySeeds.status }).from(trySeeds).where(and(eq(trySeeds.sessionId, session), eq(trySeeds.scenario, HOME_SCENARIO)));
  return !!seed && seed.status !== "ready";
}
