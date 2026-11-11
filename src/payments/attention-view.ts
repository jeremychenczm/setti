/**
 * The designer's "Needs you today": the reminders of every live project this
 * browser session owns, from each project's recorded item holds. Read only;
 * nothing here calls PayPal or moves money.
 */
import { and, eq } from "drizzle-orm";
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { pricingCases } from "../pricing/schema";
import { projectAttention, sortAttention, type AttentionItem } from "./attention";
import { lastDailyCheck } from "./daily-check";
import { itemHoldsView } from "./item-holds-view";
import { projectKeys } from "../projects/store";
import { demoDays, demoNow } from "../try/demo-time";

export interface AttentionView {
  items: AttentionItem[];
  /** The clock the reminders were worked out against. */
  checkedAt: string;
  /** The last daily check that covered these projects, and what it could not check. */
  lastCheck: { at: string; problems: string[] } | null;
  /** Days a demo session skipped ahead; the reminders are worked out for that day. */
  simulatedDays: number;
}

/** The project's name as its approved V1 gives it, else as the project is named. */
export async function sessionProjectName(db: Pick<Db, "select">, sessionId: string, key: CaseKey): Promise<string> {
  const [row] = await db.select({ name: chatCases.name, quote: pricingCases.baselineQuote }).from(chatCases).leftJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
    .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  return row?.quote?.projectName ?? row?.name ?? key;
}

/** `now` defaults to the session's clock: real time, or a demo session's simulated time. */
export async function attentionView(db: Db, sessionId: string | null, account: DemoAccount | null, at?: Date): Promise<AttentionView> {
  const simulatedDays = await demoDays(db, sessionId);
  const now = at ?? demoNow(simulatedDays);
  const items: AttentionItem[] = [];
  if (sessionId && account?.role === "designer") {
    for (const key of await projectKeys(db, sessionId)) {
      if (!canOpenProject(account, key)) continue;
      const view = await itemHoldsView(db, sessionId, key, account);
      items.push(...projectAttention(view, await sessionProjectName(db, sessionId, key), now));
    }
  }
  return { items: sortAttention(items), checkedAt: now.toISOString(), lastCheck: account?.role === "designer" ? await lastDailyCheck(db, sessionId) : null, simulatedDays };
}
