/**
 * The end of a demo. A demo session ends after IDLE_DAYS without use, or when
 * its visitor selects End demo & reset. Ending it:
 *
 * 1. records when and why, so the project becomes a read-only record (the
 *    write endpoints refuse it, and the daily check no longer notices, renews
 *    or reminds);
 * 2. cancels each approved item still on hold with the reason "demo ended" and
 *    voids its holds on PayPal: a release, never a refund. Charged payments
 *    stay as they are;
 * 3. tells both people in the project chat, once.
 *
 * Ending is safe to repeat: a release PayPal did not confirm is tried again by
 * the next daily check, and a payment step still in progress is left until its
 * result is known.
 */
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { chatCases, chatMessages } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, paypalAuthorizations } from "../db/schema";
import { pricingCases } from "../pricing/schema";
import { openHolds } from "../payments/actions";
import { cancelApprovedItem } from "../payments/cancel-item";
import type { PayPalPayments } from "../payments/paypal";
import { lockPaymentBasis } from "../payments/services";
import { demoActivity, type DemoEndReason } from "./schema";

/** Days without use after which the daily check ends a demo. */
export const IDLE_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OPEN = ["created", "partially_captured"] as const;

export interface DemoEnd { at: string; reason: DemoEndReason }

/** Notes that the session was used now; written at most once an hour, and never after the demo ended. */
export async function noteActivity(db: Db, sessionId: string, now = new Date()): Promise<void> {
  await db.insert(demoActivity).values({ sessionId, lastActiveAt: now }).onConflictDoUpdate({
    target: demoActivity.sessionId,
    set: { lastActiveAt: now },
    setWhere: and(isNull(demoActivity.endedAt), lt(demoActivity.lastActiveAt, new Date(now.getTime() - HOUR_MS))),
  });
}

/** When and why the session's demo ended, or null while it is open. */
export async function demoEnd(db: Pick<Db, "select">, sessionId: string): Promise<DemoEnd | null> {
  const [row] = await db.select({ endedAt: demoActivity.endedAt, endReason: demoActivity.endReason }).from(demoActivity).where(eq(demoActivity.sessionId, sessionId));
  return row?.endedAt && row.endReason ? { at: row.endedAt.toISOString(), reason: row.endReason } : null;
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const day = (date: Date) => date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** What both people read in the chat when Setti ends the demo with items on hold. */
export function demoEndedNotice(input: { reason: DemoEndReason; at: Date; items: number; heldCents: number }): string {
  const why = input.reason === "idle"
    ? `This demo ended on ${day(input.at)}, after ${IDLE_DAYS} days without activity.`
    : `This demo was ended with End demo & reset on ${day(input.at)}.`;
  const things = input.items === 1 ? "the 1 item still on hold" : `the ${input.items} items still on hold`;
  return `${why} Setti cancelled ${things} and asked PayPal to release ${usd(input.heldCents)}; nothing was charged for them. Payments already charged stay as they are. This project stays here as a record; to try Setti again, start a new demo from /try.`;
}

export interface EndDemoResult {
  /** True when this call ended the demo; false when it had already ended. */
  ended: boolean;
  /** Holds PayPal confirmed as released in this call. */
  released: number;
  problems: string[];
}

/** Records that the demo ended, unless it already had; the first end keeps its time and reason. */
export async function markDemoEnded(db: Db, sessionId: string, reason: DemoEndReason, now = new Date()): Promise<void> {
  await db.insert(demoActivity).values({ sessionId, lastActiveAt: now, endedAt: now, endReason: reason }).onConflictDoUpdate({
    target: demoActivity.sessionId, set: { endedAt: now, endReason: reason }, setWhere: isNull(demoActivity.endedAt),
  });
}

/** Ends the session's demo (if it has not ended yet) and releases what it still holds. */
export async function endDemo(db: Db, paypal: PayPalPayments, sessionId: string, reason: DemoEndReason, now = new Date()): Promise<EndDemoResult> {
  const before = await demoEnd(db, sessionId);
  if (!before) await markDemoEnded(db, sessionId, reason, now);
  const end = (await demoEnd(db, sessionId))!;
  const problems: string[] = [];
  let released = 0;

  const scopes = await db.select({ caseId: chatCases.id, projectKey: chatCases.projectKey, projectId: pricingCases.projectId })
    .from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id)).where(eq(chatCases.sessionId, sessionId));
  for (const scope of scopes) {
    const open = await db.select({ id: paypalAuthorizations.id }).from(paypalAuthorizations)
      .where(and(eq(paypalAuthorizations.projectId, scope.projectId), inArray(paypalAuthorizations.status, [...OPEN])));
    if (!open.length) continue;
    try {
      const result = await releaseProject(db, paypal, sessionId, scope.projectKey);
      released += result.released;
      problems.push(...result.problems);
      if (result.cancelled.length) {
        const text = demoEndedNotice({ reason: end.reason, at: new Date(end.at), items: result.cancelled.length, heldCents: result.cancelled.reduce((total, item) => total + item.heldCents, 0) });
        await db.insert(chatMessages).values({ caseId: scope.caseId, id: randomUUID(), actor: "assistant", model: "notice", aiState: "completed", text });
        await db.update(chatCases).set({ updatedAt: new Date() }).where(eq(chatCases.id, scope.caseId));
      }
    } catch (error) {
      problems.push(`The holds of ${scope.projectKey} in an ended demo could not be released: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return { ended: !before, released, problems };
}

/** Cancels every approved item of the project that still holds money and voids its holds. */
async function releaseProject(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey) {
  const candidates = await db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, sessionId, key);
    const { ledger } = basis;
    const found: { itemId: string; side: "baseline" | "proposed"; name: string; heldCents: number; fresh: boolean }[] = [];
    const skipped: string[] = [];
    for (const line of basis.plan.lines) {
      const businessItem = basis.businessItem(line);
      if (!businessItem) continue;
      const holds = openHolds(ledger, businessItem);
      if (!holds.length) continue;
      const [item] = await tx.select({ kind: items.kind, name: items.name }).from(items).where(eq(items.id, businessItem));
      const charged = ledger.captures.some((capture) => capture.status !== "declined"
        && (capture.itemId === businessItem || ledger.authorizations.some((hold) => hold.id === capture.authorizationId && hold.itemId === businessItem)));
      // An open release is resumed by the cancellation below; any other open PayPal step waits for its result.
      const busy = ledger.operations.some((operation) => operation.itemId === businessItem && operation.kind !== "void" && (operation.status === "pending" || operation.status === "unknown"));
      // A cancelled item funds nothing any more (its target is 0), but its holds still have to be released.
      const cancelled = ledger.cancellations.some((entry) => entry.itemId === businessItem);
      if (item?.kind !== "furniture" || charged || busy || (!cancelled && line.targetCents === 0)) {
        skipped.push(`${item?.name ?? "An item"} still has a hold that the end of the demo did not release${busy ? " because a PayPal step for it is still open" : ""}.`);
        continue;
      }
      const heldCents = holds.reduce((total, { heldCents: held }) => total + held, 0);
      found.push({ itemId: line.itemId, side: line.side, name: item.name, heldCents, fresh: !cancelled });
    }
    return { found, skipped };
  });

  const problems = [...candidates.skipped];
  let released = 0;
  for (const candidate of candidates.found) {
    const { operations } = await cancelApprovedItem(db, paypal, sessionId, key, { itemId: candidate.itemId, side: candidate.side, reason: "demo_ended", note: "", by: "Setti" }, { system: true });
    for (const operation of operations) {
      if (operation.status === "succeeded") released += 1;
      else problems.push(`The hold for ${candidate.name} was not released yet (${operation.status}); the next daily check tries again.`);
    }
  }
  return { cancelled: candidates.found.filter((candidate) => candidate.fresh), released, problems };
}

/**
 * The daily check's first step: ends every demo unused for IDLE_DAYS, and
 * finishes releasing the holds of demos that ended earlier. A session's last
 * use is its last noted activity, or when its first project was opened.
 */
export async function closeIdleDemos(db: Db, paypal: PayPalPayments, now: Date): Promise<{ ended: number; released: number; problems: string[] }> {
  const cutoff = now.getTime() - IDLE_DAYS * DAY_MS;
  const sessions = await db.select({ sessionId: chatCases.sessionId, openedAt: chatCases.createdAt, lastActiveAt: demoActivity.lastActiveAt, endedAt: demoActivity.endedAt, endReason: demoActivity.endReason })
    .from(chatCases).leftJoin(demoActivity, eq(demoActivity.sessionId, chatCases.sessionId));
  const holding = new Set((await db.selectDistinct({ sessionId: chatCases.sessionId }).from(paypalAuthorizations)
    .innerJoin(pricingCases, eq(pricingCases.projectId, paypalAuthorizations.projectId))
    .innerJoin(chatCases, eq(chatCases.id, pricingCases.caseId))
    .where(and(inArray(paypalAuthorizations.status, [...OPEN]), isNotNull(paypalAuthorizations.itemId)))).map((row) => row.sessionId));

  const bySession = new Map<string, { lastUse: number; endReason: DemoEndReason | null }>();
  for (const row of sessions) {
    const lastUse = (row.lastActiveAt ?? row.openedAt).getTime();
    const known = bySession.get(row.sessionId);
    // A session's projects share one activity row; without one, its earliest project tells when it began.
    bySession.set(row.sessionId, { lastUse: known ? (row.lastActiveAt ? lastUse : Math.min(known.lastUse, lastUse)) : lastUse, endReason: row.endedAt ? row.endReason : null });
  }

  let ended = 0, released = 0;
  const problems: string[] = [];
  for (const [sessionId, session] of bySession) {
    const idle = !session.endReason && session.lastUse <= cutoff;
    const unfinished = !!session.endReason && holding.has(sessionId);
    if (!idle && !unfinished) continue;
    const result = await endDemo(db, paypal, sessionId, session.endReason ?? "idle", now);
    if (result.ended) ended += 1;
    released += result.released;
    problems.push(...result.problems);
  }
  return { ended, released, problems };
}
