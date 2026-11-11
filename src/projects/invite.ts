/**
 * Bringing a client into a project. The studio's designer makes a link and sends it
 * themselves; the client opens it, signs in or creates a client account, and
 * joins. A link works once and for seven days, and a new one turns off the
 * project's earlier links. Only the token's SHA-256 is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { studios, users } from "@/auth/schema";
import { chatCases, projectClients, projectInvites } from "@/chat/schema";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import type { Actor } from "@/http/identity";

export const INVITE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InviteErrorCode = "NOT_FOUND" | "HAS_CLIENT" | "EXPIRED" | "USED" | "REPLACED" | "STUDIO_ACCOUNT" | "DEMO_ACCOUNT";

export class InviteError extends Error {
  constructor(readonly code: InviteErrorCode, message: string) {
    super(message);
  }
}

const HAS_CLIENT = () => new InviteError("HAS_CLIENT", "This project already has a client.");
const NOT_FOUND = () => new InviteError("NOT_FOUND", "This invite link does not work. Ask your designer for a new one.");

export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new link for the studio's project `key`, which replaces any earlier one. */
export async function createInvite(db: Db, studioId: string, key: string, designerId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ id: chatCases.id }).from(chatCases)
      .where(and(eq(chatCases.sessionId, studioId), eq(chatCases.projectKey, key))).for("update");
    if (!project) throw new InviteError("NOT_FOUND", "Project not found.");
    const [client] = await tx.select({ id: projectClients.id }).from(projectClients).where(eq(projectClients.caseId, project.id)).limit(1);
    if (client) throw HAS_CLIENT();
    await tx.update(projectInvites).set({ revokedAt: now })
      .where(and(eq(projectInvites.caseId, project.id), isNull(projectInvites.acceptedAt), isNull(projectInvites.revokedAt)));
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + INVITE_DAYS * DAY_MS);
    await tx.insert(projectInvites).values({ caseId: project.id, tokenHash: inviteTokenHash(token), createdBy: designerId, createdAt: now, expiresAt });
    return { token, expiresAt };
  });
}

export interface InviteView {
  status: "open" | "expired" | "used" | "replaced";
  projectName: string;
  studioName: string;
  designerName: string;
  /** Where the project lives, to tell whether the viewer is already in it. */
  studioId: string;
  key: CaseKey;
}

/** What the invite page shows for a link, or null when the link was never made. */
export async function readInvite(db: Pick<Db, "select">, token: string, now = new Date()): Promise<InviteView | null> {
  const [row] = await db.select({
    expiresAt: projectInvites.expiresAt, acceptedAt: projectInvites.acceptedAt, revokedAt: projectInvites.revokedAt,
    projectName: chatCases.name, key: chatCases.projectKey, studioId: chatCases.sessionId, studioName: studios.name, designerName: users.name,
  }).from(projectInvites)
    .innerJoin(chatCases, eq(chatCases.id, projectInvites.caseId))
    .innerJoin(studios, eq(studios.id, chatCases.sessionId))
    .innerJoin(users, eq(users.id, projectInvites.createdBy))
    .where(eq(projectInvites.tokenHash, inviteTokenHash(token)));
  if (!row) return null;
  const status = row.acceptedAt ? "used" : row.revokedAt ? "replaced" : row.expiresAt <= now ? "expired" : "open";
  return { status, projectName: row.projectName, studioName: row.studioName, designerName: row.designerName, studioId: row.studioId, key: row.key };
}

/**
 * Adds the signed-in client to the link's project and closes the link. A studio
 * account cannot join as a client, since it opens its own studio's projects;
 * nor can a demo person's account.
 */
export async function acceptInvite(db: Db, token: string, actor: Pick<Actor, "userId" | "studio" | "demoPersona">, now = new Date()): Promise<{ studioId: string; key: CaseKey }> {
  if (actor.demoPersona) throw new InviteError("DEMO_ACCOUNT", "Demo accounts cannot join projects. Sign in with your own account.");
  if (actor.studio) throw new InviteError("STUDIO_ACCOUNT", "This account runs a studio. Sign out, then join with a client account.");
  const tokenHash = inviteTokenHash(token);
  return db.transaction(async (tx) => {
    const [found] = await tx.select({ caseId: projectInvites.caseId }).from(projectInvites).where(eq(projectInvites.tokenHash, tokenHash));
    if (!found) throw NOT_FOUND();
    // The project first, then the link: the same order as making a link, so the two never wait on each other.
    const [project] = await tx.select({ id: chatCases.id, studioId: chatCases.sessionId, key: chatCases.projectKey }).from(chatCases)
      .where(eq(chatCases.id, found.caseId)).for("update");
    const [invite] = await tx.select().from(projectInvites).where(eq(projectInvites.tokenHash, tokenHash)).for("update");
    if (!project || !invite) throw NOT_FOUND();
    const joined = { studioId: project.studioId, key: project.key };
    if (invite.acceptedAt) {
      if (invite.acceptedBy === actor.userId) return joined;
      throw new InviteError("USED", "This invite link has already been used. Ask your designer for a new one.");
    }
    if (invite.revokedAt) throw new InviteError("REPLACED", "Your designer made a newer link for this project. Ask them for the latest one.");
    if (invite.expiresAt <= now) throw new InviteError("EXPIRED", "This invite link has expired. Ask your designer for a new one.");
    const [client] = await tx.select({ id: projectClients.id }).from(projectClients).where(eq(projectClients.caseId, project.id)).limit(1);
    if (client) throw HAS_CLIENT();
    await tx.insert(projectClients).values({ caseId: project.id, userId: actor.userId, createdAt: now });
    await tx.update(projectInvites).set({ acceptedAt: now, acceptedBy: actor.userId }).where(eq(projectInvites.id, invite.id));
    return joined;
  });
}
