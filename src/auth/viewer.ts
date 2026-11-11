/**
 * Who is looking at a server-rendered page. Workspace pages need a signed-in
 * viewer and send anyone else to sign in, then back to the page they asked for.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { appDb } from "@/db/shared";
import { actorFrom, homeOf, scopeOf, type Actor } from "@/http/identity";
import { appAuth } from "./app";

export interface Viewer {
  actor: Actor;
  /** Who the viewer acts as on this page. */
  account: DemoAccount;
  /** A visitor's demo account, which switches between the demo's people. */
  demo: boolean;
}

export async function currentActor(): Promise<Actor | null> {
  return actorFrom(appAuth(), appDb(), await headers());
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
