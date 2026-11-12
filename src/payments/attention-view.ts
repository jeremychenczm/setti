/**
 * The designer's "Needs you today": the reminders of every live project this
 * browser session owns, from each project's recorded item holds, and in a demo
 * the prepared example projects' to-dos, as Money's "Needs you" lists them.
 * Read only; nothing here calls PayPal or moves money.
 */
import { and, eq } from "drizzle-orm";
import { canOpenProject, type DemoAccount } from "../accounts/demo";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { exampleProjects } from "../money-desk/examples";
import { pricingCases } from "../pricing/schema";
import { projectAttention, sortAttention, type AttentionItem } from "./attention";
import { lastDailyCheck } from "./daily-check";
import { itemHoldsView } from "./item-holds-view";
import { isRealStudio, projectKeys } from "../projects/store";
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

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * The prepared example projects' to-dos: every example item that waits for the
 * designer on Money's desk (its "Needs you"), worded as a reminder. Example data
 * names no supplier, and its clock does not move, so each is for today.
 */
export function exampleAttention(): AttentionItem[] {
  return exampleProjects().flatMap((project) => project.items.filter((item) => item.waitingOn === "designer").map((item): AttentionItem => {
    const credit = item.toRefundCents > 0;
    const kind = credit ? "awaiting_credit" : "awaiting_confirmation";
    return {
      id: `${project.id}:baseline:${item.id}:${kind}`, kind, projectKey: project.id, projectName: project.name, source: "example",
      itemId: item.id, side: "baseline", itemLabel: item.name, supplier: null,
      amount: credit ? { cents: item.toRefundCents, part: "toRefund" } : { cents: item.heldCents, part: "held" },
      title: `${item.name} · ${credit ? "awaiting supplier credit" : "awaiting supplier confirmation"}`,
      detail: credit ? `${usd(item.toRefundCents)} goes back to the client once the supplier's credit arrives: record the credit, then refund it.`
        : `${usd(item.heldCents)} is on hold. Record the supplier's confirmation, then charge it.`,
      urgency: "now", href: `/quotes/${project.id}?tab=payments`,
    };
  }));
}

/** Every reminder of the designer's studio: the live projects', then in a demo the examples', as Money counts them. */
export async function studioAttention(db: Db, sessionId: string | null, account: DemoAccount | null, at?: Date): Promise<AttentionView> {
  const view = await attentionView(db, sessionId, account, at);
  if (account?.role !== "designer" || (sessionId && await isRealStudio(db, sessionId))) return view;
  return { ...view, items: sortAttention([...view.items, ...exampleAttention()]) };
}
