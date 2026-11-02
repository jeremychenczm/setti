/**
 * The designer's "Needs you today": the reminders of every live project this
 * browser session owns, from each project's recorded item holds. Read only;
 * nothing here calls PayPal or moves money.
 */
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import { caseDocument } from "../chat/cases";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { projectAttention, sortAttention, type AttentionItem } from "./attention";
import { lastDailyCheck } from "./daily-check";
import { itemHoldsView } from "./item-holds-view";
import { demoDays, demoNow } from "../try/demo-time";

const PROJECTS: CaseKey[] = ["willow", "maple"];

export interface AttentionView {
  items: AttentionItem[];
  /** The clock the reminders were worked out against. */
  checkedAt: string;
  /** The last daily check that covered these projects, and what it could not check. */
  lastCheck: { at: string; problems: string[] } | null;
  /** Days a demo session skipped ahead; the reminders are worked out for that day. */
  simulatedDays: number;
}

/** `now` defaults to the session's clock: real time, or a demo session's simulated time. */
export async function attentionView(db: Db, sessionId: string | null, account: DemoAccount | null, at?: Date): Promise<AttentionView> {
  const simulatedDays = await demoDays(db, sessionId);
  const now = at ?? demoNow(simulatedDays);
  const items: AttentionItem[] = [];
  if (sessionId && account?.role === "designer") {
    for (const key of PROJECTS) {
      if (!canOpenProject(account, key)) continue;
      const view = await itemHoldsView(db, sessionId, key, account);
      items.push(...projectAttention(view, caseDocument(key).projectName, now));
    }
  }
  return { items: sortAttention(items), checkedAt: now.toISOString(), lastCheck: account?.role === "designer" ? await lastDailyCheck(db, sessionId) : null, simulatedDays };
}
