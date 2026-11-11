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
 * 3. Two days after that notice, from day 25, each such hold is renewed with the
 *    saved payment method: a new hold first, then the old one is voided (see
 *    renew.ts). Both people are told what was renewed, by PayPal id.
 *
 * Before all of this, the studio-wide run ends every demo unused for a week
 * and releases its holds (see try/activity.ts); an ended demo gets no notices
 * or renewals.
 *
 * Renewals move holds, never charges. Every run is recorded with what it found.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { DEMO_ACCOUNTS } from "../accounts/demo";
import { chatCases, chatMessages } from "../chat/schema";
import { quoteDesignerName } from "../projects/settings";
import type { Db } from "../db/client";
import { demoActivity, holdChecks, paymentOperations, paypalAuthorizations, projects, renewalNotices, savedPaymentMethods } from "../db/schema";
import { pricingCases } from "../pricing/schema";
import { closeIdleDemos } from "../try/activity";
import { renewalNotice, renewalNoticesDue } from "./attention";
import { holdClock } from "./hold-clock";
import { itemHoldsView } from "./item-holds-view";
import { renewalReport, renewDueHolds } from "./renew";
import type { PayPalPayments } from "./paypal";
import type { HoldReadback } from "./schema";

const OPEN = ["created", "partially_captured"] as const;

export interface DailyCheckResult {
  id: string;
  checkedAt: string;
  /** Open item holds looked at. */
  holds: number;
  readbacks: HoldReadback[];
  /** Holds this run announced in a renewal notice. */
  notices: number;
  /** Holds this run renewed with the client's saved payment method. */
  renewals: number;
  /** Demos this run ended after a week without use. */
  endedDemos: number;
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

  // 0. Demos unused for a week end, and their holds are released. A demo's own skip-ahead run never ends it.
  let endedDemos = 0;
  if (!options.sessionId) {
    const closed = await closeIdleDemos(db, paypal, now);
    endedDemos = closed.ended;
    problems.push(...closed.problems);
  }
  const ended = new Set((await db.select({ sessionId: demoActivity.sessionId }).from(demoActivity).where(isNotNull(demoActivity.endedAt))).map((row) => row.sessionId));

  const allScopes = await db.select({ caseId: chatCases.id, sessionId: chatCases.sessionId, projectKey: chatCases.projectKey, projectId: pricingCases.projectId, clientName: projects.clientName, quote: chatCases.quote })
    .from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id)).innerJoin(projects, eq(projects.id, pricingCases.projectId))
    .where(options.sessionId ? eq(chatCases.sessionId, options.sessionId) : undefined);
  const scopes = allScopes.filter((scope) => !ended.has(scope.sessionId));
  const projectIds = [...new Set(scopes.map((scope) => scope.projectId))];
  const open = projectIds.length ? await db.select().from(paypalAuthorizations)
    .where(and(inArray(paypalAuthorizations.projectId, projectIds), inArray(paypalAuthorizations.status, [...OPEN]), isNotNull(paypalAuthorizations.itemId))) : [];

  // 1. Holds past their 29 days: ask PayPal where each one stands.
  const readbacks: HoldReadback[] = [];
  const operations = projectIds.length ? await db.select({ id: paymentOperations.id, renewedAt: paymentOperations.renewedAt }).from(paymentOperations).where(inArray(paymentOperations.projectId, projectIds)) : [];
  for (const hold of open) {
    if (holdClock(hold, operations).expiresAt.getTime() <= now.getTime()) readbacks.push(await readBack(db, paypal, hold, problems));
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
        const recorded = await tx.insert(renewalNotices).values(due.map((line) => ({ authorizationId: line.timing!.holdId, caseId: scope.caseId, messageId, noticedAt: now })))
          .onConflictDoNothing().returning({ authorizationId: renewalNotices.authorizationId });
        const fresh = due.filter((line) => recorded.some((entry) => entry.authorizationId === line.timing!.holdId));
        if (!fresh.length) return 0;
        const text = renewalNotice({ lines: fresh, client: scope.clientName, designer: quoteDesignerName(scope.quote), method: { kind: method.kind, label: method.label }, now });
        await tx.insert(chatMessages).values({ caseId: scope.caseId, id: messageId, actor: "assistant", model: "notice", aiState: "completed", text });
        await tx.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, scope.caseId));
        return fresh.length;
      });
    } catch (error) {
      problems.push(`The holds of ${scope.projectKey} could not be checked: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // 3. Renewals, two days after their notice.
  let renewals = 0;
  for (const scope of scopes) {
    if (!open.some((hold) => hold.projectId === scope.projectId)) continue;
    try {
      const outcomes = await renewDueHolds(db, paypal, { sessionId: scope.sessionId, projectKey: scope.projectKey }, now);
      renewals += outcomes.filter((outcome) => outcome.fresh && (outcome.status === "renewed" || outcome.status === "old_still_open")).length;
      for (const outcome of outcomes) {
        if (outcome.status === "failed" || outcome.status === "unknown") problems.push(`Hold ${outcome.oldAuthorizationId} for ${outcome.itemLabel} was not renewed: ${outcome.message}`);
        if (outcome.status === "old_still_open") problems.push(`Hold ${outcome.oldAuthorizationId} for ${outcome.itemLabel} was renewed but not released yet: ${outcome.message ?? "PayPal did not confirm the release."}`);
      }
      const [method] = await db.select({ kind: savedPaymentMethods.kind, label: savedPaymentMethods.label }).from(savedPaymentMethods)
        .where(eq(savedPaymentMethods.projectId, scope.projectId)).orderBy(desc(savedPaymentMethods.createdAt)).limit(1);
      const text = renewalReport(outcomes, { client: scope.clientName, designer: quoteDesignerName(scope.quote), method: { kind: method?.kind === "card" ? "card" : "paypal", label: method?.label ?? null } });
      if (text) {
        await db.insert(chatMessages).values({ caseId: scope.caseId, id: randomUUID(), actor: "assistant", model: "notice", aiState: "completed", text });
        await db.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, scope.caseId));
      }
    } catch (error) {
      problems.push(`The holds of ${scope.projectKey} could not be renewed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  await db.update(holdChecks).set({ finishedAt: new Date(), holds: open.length, readbacks, notices, renewals, endedDemos, problems }).where(eq(holdChecks.id, run.id));
  return { id: run.id, checkedAt: now.toISOString(), holds: open.length, readbacks, notices, renewals, endedDemos, problems };
}

/** The latest finished run that covers this session: its own demo run, or a studio-wide one. */
export async function lastDailyCheck(db: Pick<Db, "select">, sessionId: string | null): Promise<{ at: string; problems: string[] } | null> {
  const [latest] = await db.select({ finishedAt: holdChecks.finishedAt, problems: holdChecks.problems }).from(holdChecks)
    .where(and(isNotNull(holdChecks.finishedAt), sessionId ? or(isNull(holdChecks.sessionId), eq(holdChecks.sessionId, sessionId)) : isNull(holdChecks.sessionId)))
    .orderBy(desc(holdChecks.finishedAt)).limit(1);
  return latest ? { at: latest.finishedAt!.toISOString(), problems: latest.problems } : null;
}
