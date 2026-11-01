/**
 * The daily check, once a day for the whole studio (or for one demo session):
 *
 * 1. Holds past their 29 days are read back from PayPal. An expired or voided
 *    hold is recorded as closed. A hold PayPal still reports as held stays as
 *    it is (Sandbox holds never expire by themselves). A hold PayPal could not
 *    be asked about is a problem of the run, never counted as fine.
 * 2. Holds in their last week that still wait for their supplier, where the
 *    client saved a payment method, get the renewal notice in the project chat:
 *    once per hold, as one automatic notice per project both people see.
 *
 * Nothing here moves money. Every run is recorded with what it found.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { chatCases, chatMessages } from "../chat/schema";
import type { Db } from "../db/client";
import { holdChecks, paypalAuthorizations, projects, renewalNotices } from "../db/schema";
import { AUTHORIZATION_VALIDITY_DAYS } from "../money/authorization";
import { pricingCases } from "../pricing/schema";
import { renewalNotice, renewalNoticesDue } from "./attention";
import { itemHoldsView } from "./item-holds-view";
import type { PayPalPayments } from "./paypal";
import type { HoldReadback } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["created", "partially_captured"] as const;

export interface DailyCheckResult {
  id: string;
  checkedAt: string;
  /** Open item holds looked at. */
  holds: number;
  readbacks: HoldReadback[];
  /** Holds this run announced in a renewal notice. */
  notices: number;
  problems: string[];
}

type Hold = typeof paypalAuthorizations.$inferSelect;

async function readBack(db: Db, paypal: PayPalPayments, hold: Hold, problems: string[]): Promise<HoldReadback> {
  const id = hold.paypalAuthorizationId;
  const read = await paypal.getAuthorization(id);
  if (read.kind !== "ok") {
    problems.push(`PayPal could not be asked about hold ${id}: ${read.message}`);
    return { paypalAuthorizationId: id, outcome: "unreadable", paypalStatus: null, debugId: read.trace?.debugId ?? null };
  }
  const status = read.value.status ?? null;
  const debugId = read.trace?.debugId ?? null;
  const closed = status === "EXPIRED" ? "expired" : status === "VOIDED" ? "voided" : null;
  if (closed) {
    await db.update(paypalAuthorizations).set({ status: closed }).where(and(eq(paypalAuthorizations.id, hold.id), inArray(paypalAuthorizations.status, [...OPEN])));
    return { paypalAuthorizationId: id, outcome: closed, paypalStatus: status, debugId };
  }
  if (status === "CAPTURED" || status === "PARTIALLY_CAPTURED") {
    problems.push(`PayPal reports hold ${id} as ${status}, which Setti has no record of. Reconcile it by hand.`);
    return { paypalAuthorizationId: id, outcome: "captured_elsewhere", paypalStatus: status, debugId };
  }
  return { paypalAuthorizationId: id, outcome: "still_held", paypalStatus: status, debugId };
}

export async function runDailyCheck(db: Db, paypal: PayPalPayments, options: { now?: Date; sessionId?: string } = {}): Promise<DailyCheckResult> {
  const now = options.now ?? new Date();
  const [run] = await db.insert(holdChecks).values({ checkedAt: now, sessionId: options.sessionId ?? null }).returning();
  const problems: string[] = [];

  const scopes = await db.select({ caseId: chatCases.id, sessionId: chatCases.sessionId, projectKey: chatCases.projectKey, projectId: pricingCases.projectId, clientName: projects.clientName })
    .from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id)).innerJoin(projects, eq(projects.id, pricingCases.projectId))
    .where(options.sessionId ? eq(chatCases.sessionId, options.sessionId) : undefined);
  const projectIds = [...new Set(scopes.map((scope) => scope.projectId))];
  const open = projectIds.length ? await db.select().from(paypalAuthorizations)
    .where(and(inArray(paypalAuthorizations.projectId, projectIds), inArray(paypalAuthorizations.status, [...OPEN]), isNotNull(paypalAuthorizations.itemId))) : [];

  // 1. Holds past their 29 days: ask PayPal where each one stands.
  const readbacks: HoldReadback[] = [];
  for (const hold of open) {
    const expiresAt = hold.expiresAt ?? new Date(hold.createdAt.getTime() + AUTHORIZATION_VALIDITY_DAYS * DAY_MS);
    if (expiresAt.getTime() <= now.getTime()) readbacks.push(await readBack(db, paypal, hold, problems));
  }

  // 2. The renewal notice, in each project that still has open holds.
  const designer = DEMO_ACCOUNTS.find((account) => account.role === "designer")!;
  let notices = 0;
  for (const scope of scopes) {
    if (!open.some((hold) => hold.projectId === scope.projectId)) continue;
    try {
      const view = await itemHoldsView(db, scope.sessionId, scope.projectKey, designer);
      const method = view.savedMethod;
      if (!method) continue;
      const due = renewalNoticesDue(view, now);
      if (!due.length) continue;
      // Each hold is announced once: the holds not announced before go into one message, written with their records.
      const messageId = randomUUID();
      notices += await db.transaction(async (tx) => {
        const recorded = await tx.insert(renewalNotices).values(due.map((line) => ({ authorizationId: line.timing!.holdId, caseId: scope.caseId, messageId })))
          .onConflictDoNothing().returning({ authorizationId: renewalNotices.authorizationId });
        const fresh = due.filter((line) => recorded.some((entry) => entry.authorizationId === line.timing!.holdId));
        if (!fresh.length) return 0;
        const text = renewalNotice({ lines: fresh, client: scope.clientName, designer: designer.name, method: { kind: method.kind, label: method.label } });
        await tx.insert(chatMessages).values({ caseId: scope.caseId, id: messageId, actor: "assistant", model: "notice", aiState: "completed", text });
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, scope.caseId));
        return fresh.length;
      });
    } catch (error) {
      problems.push(`The holds of ${scope.projectKey} could not be checked: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  await db.update(holdChecks).set({ finishedAt: new Date(), holds: open.length, readbacks, notices, problems }).where(eq(holdChecks.id, run.id));
  return { id: run.id, checkedAt: now.toISOString(), holds: open.length, readbacks, notices, problems };
}

/** The latest finished run that covers this session: its own demo run, or a studio-wide one. */
export async function lastDailyCheck(db: Pick<Db, "select">, sessionId: string | null): Promise<{ at: string; problems: string[] } | null> {
  const [latest] = await db.select({ finishedAt: holdChecks.finishedAt, problems: holdChecks.problems }).from(holdChecks)
    .where(and(isNotNull(holdChecks.finishedAt), sessionId ? or(isNull(holdChecks.sessionId), eq(holdChecks.sessionId, sessionId)) : isNull(holdChecks.sessionId)))
    .orderBy(desc(holdChecks.finishedAt)).limit(1);
  return latest ? { at: latest.finishedAt!.toISOString(), problems: latest.problems } : null;
}
