/** A designer creates a project in their studio: its V1 starts as a draft with no lines yet. */
import { randomUUID } from "node:crypto";
import { PROJECT_KEY_MAX } from "@/chat/cases";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { STUDIO_CASES } from "@/demo/studio-cases";
import type { QuoteDocument } from "@/quotes/types";
import { projectKeys, insertProject } from "./store";

export const PROJECT_NAME_MAX = 80;
export const PROJECT_SUBTITLE_MAX = 120;
/** The most projects a visitor's demo studio holds, its sample project included. */
export const DEMO_PROJECTS_MAX = 6;

/** Whether the demo studio already holds as many projects as a demo may. */
export async function demoStudioFull(db: Pick<Db, "select">, studioId: string): Promise<boolean> {
  return (await projectKeys(db, studioId)).length >= DEMO_PROJECTS_MAX;
}

/** The demo's prepared studio projects use these in the same URLs. */
const RESERVED = new Set(STUDIO_CASES.map((project) => project.id));

/** The project's short name: its name in lowercase words, made unique in the studio with -2, -3… */
export function projectKeyFor(name: string, taken: Iterable<CaseKey>): CaseKey {
  const used = new Set(taken);
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PROJECT_KEY_MAX - 4).replace(/-+$/, "") || "project";
  let key = base;
  for (let n = 2; used.has(key) || RESERVED.has(key); n++) key = `${base}-${n}`;
  return key;
}

/** An empty V1 in the project's name; the designer adds its lines before sending it. */
function emptyQuote(key: CaseKey, name: string, designerName: string): QuoteDocument {
  return {
    id: `${key}-v1-${randomUUID().slice(0, 8)}`, version: 1, projectId: key, projectName: name, room: "", clientName: "", designerName,
    currency: "USD", isDemo: true, demoNotice: "", paymentNote: "", assumptions: [], lines: [],
  };
}

export async function createProject(db: Db, studioId: string, designerName: string, input: { name: string; subtitle: string }): Promise<CaseKey> {
  return db.transaction(async (tx) => {
    const key = projectKeyFor(input.name, await projectKeys(tx, studioId));
    await insertProject(tx, studioId, key, { name: input.name, subtitle: input.subtitle, startsFrom: "draft_quote", quote: emptyQuote(key, input.name, designerName) });
    return key;
  });
}
