/**
 * Who is looking at a server-rendered page. Workspace pages need a signed-in
 * viewer and send anyone else to sign in, then back to the page they asked for.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { DemoAccount } from "@/accounts/demo";
import { isCaseKey } from "@/chat/cases";
import type { CaseKey } from "@/chat/types";
import { appDb } from "@/db/shared";
import { actorFrom, homeOf, scopeOf, type Actor } from "@/http/identity";
import { projectAvailable } from "@/projects/store";
import { projectsFor } from "@/projects/summary";
import type { ProjectSummary } from "@/projects/types";
import { appAuth } from "./app";

export interface Viewer {
  actor: Actor;
  /** Who the viewer acts as on this page. */
  account: DemoAccount;
  /** A visitor's demo account, which switches between the demo's people. */
  demo: boolean;
}

export async function currentActor(): Promise<Actor | null> {
  // The request's headers first: they make the page dynamic, so a build never opens the database for it.
  const requestHeaders = await headers();
  return actorFrom(appAuth(), appDb(), requestHeaders);
}

export function signInPath(next: string): string {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/** The signed-in viewer, acting in project `key` when they are part of it; signed out, the request goes to sign in. */
export async function requireViewer(path: string, key?: CaseKey): Promise<Viewer> {
  const actor = await currentActor();
  if (!actor) redirect(signInPath(path));
  const account = (key && scopeOf(actor, key)?.account) || homeOf(actor).account;
  return { actor, account, demo: actor.demoPersona !== null };
}

/**
 * What a workspace page needs: the signed-in viewer and the projects they work
 * in. Opening `key` in a demo studio first gives it the sample of that name.
 */
export async function requireWorkspace(path: string, key?: CaseKey): Promise<Viewer & { projects: ProjectSummary[] }> {
  const viewer = await requireViewer(path, key);
  if (key && isCaseKey(key) && viewer.actor.studio) await projectAvailable(appDb(), viewer.actor.studio.id, key);
  return { ...viewer, projects: await projectsFor(appDb(), viewer.actor) };
}
