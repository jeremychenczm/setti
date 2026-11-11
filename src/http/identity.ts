/**
 * Who a request is and what it may open. Every API route and server page asks
 * here. A studio member opens every project of their studio; a client opens only
 * the projects they were added to, in whichever studio owns them. A project's data
 * lives under its studio's id, which the stores still call the session id.
 */
import { desc, eq } from "drizzle-orm";
import { DEMO_ACCOUNTS, type DemoAccount } from "@/accounts/demo";
import { studios, users, type DemoPersona } from "@/auth/schema";
import type { Auth } from "@/auth/server";
import { activeStudio } from "@/auth/studio";
import { chatCases, projectClients } from "@/chat/schema";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";

export interface ClientProject {
  studioId: string;
  caseId: string;
  key: CaseKey;
}

export interface Actor {
  userId: string;
  /** The sign-in session the request came with. */
  authSessionId: string;
  name: string;
  email: string;
  /** The demo person a visitor's throwaway account plays; null on a real account. */
  demoPersona: DemoPersona | null;
  role: "designer" | "client";
  /** A studio member's studio; null for a client. */
  studio: { id: string; name: string; role: string; kind: "real" | "demo" } | null;
  /** The projects a client opens, newest first; empty for a studio member. */
  projects: ClientProject[];
}

export async function actorFrom(auth: Auth, db: Db, headers: Headers): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const [user] = await db.select({ demoPersona: users.demoPersona }).from(users).where(eq(users.id, session.user.id));
  if (!user) return null;
  const base = { userId: session.user.id, authSessionId: session.session.id, name: session.user.name, email: session.user.email, demoPersona: user.demoPersona ?? null };
  const member = await activeStudio(db, session.session);
  if (member) {
    const [studio] = await db.select({ kind: studios.kind }).from(studios).where(eq(studios.id, member.id));
    return { ...base, role: "designer", studio: { ...member, kind: studio.kind }, projects: [] };
  }
  const projects = await db.select({ studioId: chatCases.sessionId, caseId: chatCases.id, key: chatCases.projectKey })
    .from(projectClients).innerJoin(chatCases, eq(chatCases.id, projectClients.caseId))
    .where(eq(projectClients.userId, session.user.id)).orderBy(desc(projectClients.createdAt));
  return { ...base, role: "client", studio: null, projects };
}

/** The account object the stores and views take, for this actor in one project. */
export function accountOf(actor: Actor, key: CaseKey | null): DemoAccount {
  const persona = actor.demoPersona && DEMO_ACCOUNTS.find((account) => account.id === actor.demoPersona);
  if (persona) return persona;
  return actor.role === "designer"
    ? { id: actor.userId, name: actor.name, role: "designer", title: `Designer · ${actor.studio!.name}`, projectKey: null }
    : { id: actor.userId, name: actor.name, role: "client", title: "Client", projectKey: key };
}

/** Where `key`'s data lives for this actor, and who they act as there; null when they may not open it. */
export function scopeOf(actor: Actor, key: CaseKey): { sessionId: string; account: DemoAccount } | null {
  if (actor.studio) return { sessionId: actor.studio.id, account: accountOf(actor, null) };
  const project = actor.projects.find((entry) => entry.key === key);
  return project ? { sessionId: project.studioId, account: accountOf(actor, key) } : null;
}

/** Who this actor is in the project `key` of studio `studioId`, or null when they are not part of it. */
export function projectAccess(actor: Actor, owner: { studioId: string; key: CaseKey }): DemoAccount | null {
  if (actor.studio) return actor.studio.id === owner.studioId ? accountOf(actor, null) : null;
  return actor.projects.some((project) => project.studioId === owner.studioId && project.key === owner.key) ? accountOf(actor, owner.key) : null;
}

/**
 * Where an actor's own pages (inbox, demo clock) read from: a designer's studio,
 * or a client's newest project. A client with no project yet reads nothing.
 */
export function homeOf(actor: Actor): { sessionId: string | null; account: DemoAccount } {
  if (actor.studio) return { sessionId: actor.studio.id, account: accountOf(actor, null) };
  const [newest] = actor.projects;
  return newest ? { sessionId: newest.studioId, account: accountOf(actor, newest.key) } : { sessionId: null, account: accountOf(actor, null) };
}

/** The demo run a demo person belongs to (their demo studio's id), or null for a real account. */
export function demoRunOf(actor: Actor): string | null {
  if (!actor.demoPersona) return null;
  if (actor.studio) return actor.studio.kind === "demo" ? actor.studio.id : null;
  return actor.projects[0]?.studioId ?? null;
}
