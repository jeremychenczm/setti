/**
 * The people of a demo run. Each run is a demo studio of its own, keyed by the
 * run id, with two real accounts: Jordan, its designer, and Emma, the client of
 * its Maple project. A visitor is signed in as one of them and can switch to the
 * other. Their emails cannot receive mail, and their passwords are derived from
 * the server's secret and never stored, so only this server can sign in as them.
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authAccounts, authSessions, studioMembers, studios, users, type DemoPersona } from "@/auth/schema";
import type { Auth } from "@/auth/server";
import { chatCases, projectClients } from "@/chat/schema";
import type { Db } from "@/db/client";
import { TRY_PROJECT } from "@/demo/sample-projects";
import { insertProject } from "@/projects/store";
import { TRY_PROJECT_KEY } from "./preparation";

/** A reserved domain (RFC 2606): mail to it is never delivered. */
const DEMO_EMAIL_DOMAIN = "demo.setti.invalid";
export const DEMO_STUDIO_NAME = "Lee Studio";

const PEOPLE: Record<DemoPersona, { name: string }> = { jordan: { name: "Jordan Lee" }, emma: { name: "Emma Park" } };

export interface DemoPerson { persona: DemoPersona; userId: string; email: string }

export function demoEmail(persona: DemoPersona, runId: string): string {
  return `${persona}.${runId}@${DEMO_EMAIL_DOMAIN}`;
}

/** A demo person's password: derived, never stored. 64 hex characters, within the sign-up limits. */
function demoPassword(secret: string, userId: string): string {
  return createHmac("sha256", secret).update(`setti-demo-person:${userId}`).digest("hex");
}

async function ensurePerson(db: Db, auth: Auth, runId: string, persona: DemoPersona): Promise<DemoPerson> {
  const email = demoEmail(persona, runId);
  const [found] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (found) return { persona, userId: found.id, email };
  const context = await auth.$context;
  const userId = randomUUID(), now = new Date();
  const hash = await context.password.hash(demoPassword(context.secret, userId));
  const created = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ id: userId, name: PEOPLE[persona].name, email, emailVerified: false, demoPersona: persona, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: users.email }).returning({ id: users.id });
    if (!user) return null;
    await tx.insert(authAccounts).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash, createdAt: now, updatedAt: now });
    return user.id;
  });
  // Another request made this person first.
  if (!created) return ensurePerson(db, auth, runId, persona);
  return { persona, userId: created, email };
}

/** The run's Maple project, which Emma is the client of. */
async function mapleCaseId(db: Db, runId: string): Promise<string> {
  await insertProject(db, runId, TRY_PROJECT_KEY, TRY_PROJECT);
  const [found] = await db.select({ id: chatCases.id }).from(chatCases).where(and(eq(chatCases.sessionId, runId), eq(chatCases.projectKey, TRY_PROJECT_KEY)));
  return found.id;
}

/** The run's studio and people, made once: repeating it, or resuming an older run, changes nothing already there. */
export async function ensureDemoPeople(db: Db, auth: Auth, runId: string): Promise<Record<DemoPersona, DemoPerson>> {
  await db.insert(studios).values({ id: runId, name: DEMO_STUDIO_NAME, slug: `demo-${runId}`, kind: "demo", createdAt: new Date() }).onConflictDoNothing();
  const jordan = await ensurePerson(db, auth, runId, "jordan");
  const emma = await ensurePerson(db, auth, runId, "emma");
  await db.insert(studioMembers).values({ id: randomUUID(), organizationId: runId, userId: jordan.userId, role: "owner", createdAt: new Date() }).onConflictDoNothing();
  await db.insert(projectClients).values({ caseId: await mapleCaseId(db, runId), userId: emma.userId }).onConflictDoNothing();
  return { jordan, emma };
}

/** The demo person of a run, if the run has one. */
export async function findDemoPerson(db: Db, runId: string, persona: DemoPersona): Promise<DemoPerson | null> {
  const email = demoEmail(persona, runId);
  const [found] = await db.select({ id: users.id }).from(users).where(and(eq(users.email, email), eq(users.demoPersona, persona)));
  return found ? { persona, userId: found.id, email } : null;
}

/**
 * Signs in as a demo person. The response carries the session cookie to pass on
 * to the browser; `replacing` is the browser's current session, ended so a
 * switch leaves one session behind, not two.
 */
export async function signInDemoPerson(db: Db, auth: Auth, person: DemoPerson, replacing?: string | null): Promise<Response> {
  const context = await auth.$context;
  const response = await auth.api.signInEmail({ body: { email: person.email, password: demoPassword(context.secret, person.userId) }, asResponse: true });
  if (!response.ok) throw new Error("The demo person could not be signed in.");
  if (replacing) await db.delete(authSessions).where(eq(authSessions.id, replacing));
  return response;
}
