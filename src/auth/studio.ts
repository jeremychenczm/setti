/**
 * The studio a signed-in request works in. Product code asks here rather than
 * reading the session's active organization itself: the studio must be one the
 * user is a member of, and a session that names none (as right after sign-up,
 * before the new studio exists) gets the user's first studio.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { authSessions, studioMembers, studios } from "./schema";

export interface ActiveStudio {
  id: string;
  name: string;
  /** owner, admin or member */
  role: string;
}

function membershipsOf(db: Db, userId: string, studioId?: string) {
  return db.select({ id: studios.id, name: studios.name, role: studioMembers.role }).from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.organizationId))
    .where(studioId ? and(eq(studioMembers.userId, userId), eq(studioMembers.organizationId, studioId)) : eq(studioMembers.userId, userId))
    .orderBy(asc(studioMembers.createdAt));
}

export async function activeStudio(db: Db, session: { id: string; userId: string; activeOrganizationId?: string | null }): Promise<ActiveStudio | null> {
  if (session.activeOrganizationId) {
    const [named] = await membershipsOf(db, session.userId, session.activeOrganizationId);
    if (named) return named;
  }
  const [first] = await membershipsOf(db, session.userId).limit(1);
  if (!first) return null;
  await db.update(authSessions).set({ activeOrganizationId: first.id }).where(eq(authSessions.id, session.id));
  return first;
}
