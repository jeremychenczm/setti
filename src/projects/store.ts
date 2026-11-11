/** A studio's projects: the rows that say what each project is set up as. */
import { and, asc, eq } from "drizzle-orm";
import { studios } from "@/auth/schema";
import { chatCases } from "@/chat/schema";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { sampleProject } from "@/demo/sample-projects";
import type { ProjectQuote, ProjectStart } from "./settings";

type Writer = Pick<Db, "insert" | "select">;

export interface NewProject {
  name: string;
  subtitle: string;
  startsFrom: ProjectStart;
  quote: ProjectQuote;
}

/** Adds the project unless the studio already has one with this key; the existing one is left as it is. */
export async function insertProject(db: Writer, studioId: string, key: CaseKey, project: NewProject): Promise<void> {
  await db.insert(chatCases).values({ sessionId: studioId, projectKey: key, ...project })
    .onConflictDoNothing({ target: [chatCases.sessionId, chatCases.projectKey] });
}

/** A studio its designers set up, as opposed to a demo studio or a session from before studios. */
export async function isRealStudio(db: Pick<Db, "select">, studioId: string): Promise<boolean> {
  const [studio] = await db.select({ kind: studios.kind }).from(studios).where(eq(studios.id, studioId));
  return studio?.kind === "real";
}

/** The project's settings row, or null when the studio has no project with this key. */
export async function findProject(db: Pick<Db, "select">, studioId: string, key: CaseKey) {
  const [row] = await db.select().from(chatCases).where(and(eq(chatCases.sessionId, studioId), eq(chatCases.projectKey, key)));
  return row ?? null;
}

/** The studio's project keys, oldest first. */
export async function projectKeys(db: Pick<Db, "select">, studioId: string): Promise<CaseKey[]> {
  const rows = await db.select({ key: chatCases.projectKey }).from(chatCases).where(eq(chatCases.sessionId, studioId)).orderBy(asc(chatCases.createdAt), asc(chatCases.projectKey));
  return rows.map((row) => row.key);
}

/**
 * Whether the studio has this project, after giving a demo studio, or a session
 * from before studios, the sample of that name the first time it opens it. A
 * real studio has only the projects its designers created.
 */
export async function projectAvailable(db: Writer, studioId: string, key: CaseKey): Promise<boolean> {
  if (await findProject(db, studioId, key)) return true;
  const sample = sampleProject(key);
  if (!sample || await isRealStudio(db, studioId)) return false;
  await insertProject(db, studioId, key, sample);
  return true;
}
