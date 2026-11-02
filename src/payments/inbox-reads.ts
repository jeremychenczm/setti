/**
 * What is new in an account's inbox: for the client, money records completed
 * after they last opened it; for the designer, reminders the inbox did not show
 * them then. Never having opened the inbox makes everything in it new.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { inboxReads } from "../db/schema";

export interface InboxRead { seenAt: Date; reminderIds: string[] }

export async function lastInboxRead(db: Pick<Db, "select">, sessionId: string, accountId: string): Promise<InboxRead | null> {
  const [row] = await db.select({ seenAt: inboxReads.seenAt, reminderIds: inboxReads.reminderIds }).from(inboxReads)
    .where(and(eq(inboxReads.sessionId, sessionId), eq(inboxReads.accountId, accountId)));
  return row ?? null;
}

/** The ids the reader has not seen: events completed after the last read, reminders not shown then. */
export function unreadIds(read: InboxRead | null, shown: { events: { id: string; at: string }[]; reminders: { id: string }[] }): string[] {
  if (!read) return [...shown.events.map((event) => event.id), ...shown.reminders.map((item) => item.id)];
  const seen = new Set(read.reminderIds);
  return [
    ...shown.events.filter((event) => Date.parse(event.at) > read.seenAt.getTime()).map((event) => event.id),
    ...shown.reminders.filter((item) => !seen.has(item.id)).map((item) => item.id),
  ];
}

/**
 * The reader saw the inbox as it was at `through` (never later than now), with
 * these reminders. The read time only moves forward, so an older open tab cannot
 * make seen records new again.
 */
export async function markInboxSeen(db: Pick<Db, "insert">, sessionId: string, accountId: string, input: { through: Date; reminderIds: string[] }, now = new Date()): Promise<void> {
  const seenAt = input.through.getTime() > now.getTime() ? now : input.through;
  await db.insert(inboxReads).values({ sessionId, accountId, seenAt, reminderIds: input.reminderIds })
    .onConflictDoUpdate({
      target: [inboxReads.sessionId, inboxReads.accountId],
      set: { seenAt: sql`GREATEST(${inboxReads.seenAt}, excluded.seen_at)`, reminderIds: sql`excluded.reminder_ids` },
    });
}
