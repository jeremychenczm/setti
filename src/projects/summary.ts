/** The projects a signed-in viewer works in, with the people of each, for the workspace pages. */
import { asc, eq, inArray } from "drizzle-orm";
import { DEMO_ACCOUNTS } from "@/accounts/demo";
import { studioMembers, studios, users } from "@/auth/schema";
import { chatCases, projectClients } from "@/chat/schema";
import type { Db } from "@/db/client";
import type { Actor } from "@/http/identity";
import { withoutApproval } from "@/opening/document";
import { clientSignatureName } from "@/opening/types";
import type { ProjectPerson, ProjectSummary } from "./types";

type Account = { id: string; name: string; demoPersona: string | null };

/** A demo person keeps their portrait; a real account gets a monogram. */
function person(account: Account, role: ProjectPerson["role"]): ProjectPerson {
  const demo = account.demoPersona ? DEMO_ACCOUNTS.find((entry) => entry.id === account.demoPersona) : null;
  return demo ? { id: demo.id, name: demo.name, role, avatar: demo.avatar } : { id: account.id, name: account.name, role };
}

/** A designer sees every project of their studio; a client, the projects they were added to. Oldest first. */
export async function projectsFor(db: Pick<Db, "select">, actor: Actor): Promise<ProjectSummary[]> {
  const rows = actor.studio
    ? await db.select().from(chatCases).where(eq(chatCases.sessionId, actor.studio.id)).orderBy(asc(chatCases.createdAt), asc(chatCases.projectKey))
    : actor.projects.length
      ? await db.select().from(chatCases).where(inArray(chatCases.id, actor.projects.map((project) => project.caseId))).orderBy(asc(chatCases.createdAt), asc(chatCases.projectKey))
      : [];
  if (!rows.length) return [];
  const studioIds = [...new Set(rows.map((row) => row.sessionId))];
  const studioNames = new Map((await db.select({ id: studios.id, name: studios.name }).from(studios).where(inArray(studios.id, studioIds))).map((studio) => [studio.id, studio.name]));
  const designers = await db.select({ studioId: studioMembers.organizationId, id: users.id, name: users.name, demoPersona: users.demoPersona })
    .from(studioMembers).innerJoin(users, eq(users.id, studioMembers.userId))
    .where(inArray(studioMembers.organizationId, studioIds)).orderBy(asc(studioMembers.createdAt));
  const clients = await db.select({ caseId: projectClients.caseId, id: users.id, name: users.name, demoPersona: users.demoPersona })
    .from(projectClients).innerJoin(users, eq(users.id, projectClients.userId))
    .where(inArray(projectClients.caseId, rows.map((row) => row.id))).orderBy(asc(projectClients.createdAt));
  return rows.map((row) => {
    const quote = withoutApproval(row.quote);
    const designer = designers.find((entry) => entry.studioId === row.sessionId);
    const client = clients.find((entry) => entry.caseId === row.id);
    const named = clientSignatureName(quote);
    return {
      key: row.projectKey, name: row.name, subtitle: row.subtitle, studio: studioNames.get(row.sessionId) ?? "", quote,
      designer: designer ? person(designer, "designer") : { id: `${row.sessionId}:designer`, name: quote.designerName.replace(/\s*\(demo designer\)$/, "") || "Your designer", role: "designer" },
      client: client ? person(client, "client") : named ? { id: `${row.id}:client`, name: named, role: "client" } : null,
      clientJoined: Boolean(client),
    };
  });
}

/** The one project, if the viewer works in it. */
export async function projectFor(db: Pick<Db, "select">, actor: Actor, key: string): Promise<ProjectSummary | null> {
  return (await projectsFor(db, actor)).find((project) => project.key === key) ?? null;
}

