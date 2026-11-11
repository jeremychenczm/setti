/**
 * The identity check every project API route starts with: a signed-in request
 * whose actor may open the project, and the studio whose data it reads.
 */
import { NextResponse } from "next/server";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { requestActor } from "./actor";
import { accountOf, scopeOf, type Actor } from "./identity";

export interface ProjectScope { actor: Actor; sessionId: string; account: DemoAccount }
export interface Refusal { status: 401 | 403; code: "SIGN_IN_REQUIRED" | "FORBIDDEN"; error: string }

export const SIGN_IN_REQUIRED: Refusal = { status: 401, code: "SIGN_IN_REQUIRED", error: "Sign in to continue." };
export const NOT_YOUR_PROJECT: Refusal = { status: 403, code: "FORBIDDEN", error: "This project is not one of yours." };
export const STUDIO_ONLY: Refusal = { status: 403, code: "FORBIDDEN", error: "Only the studio's designers see this." };

/** The signed-in actor's scope in project `key`, or why the request may not open it. */
export async function projectScope(req: Request, key: CaseKey): Promise<ProjectScope | Refusal> {
  const actor = await requestActor(req);
  if (!actor) return SIGN_IN_REQUIRED;
  const scope = scopeOf(actor, key);
  return scope ? { actor, ...scope } : NOT_YOUR_PROJECT;
}

/** The signed-in studio member's studio, for designer-only routes, or why the request is refused. */
export async function studioScope(req: Request): Promise<ProjectScope | Refusal> {
  const actor = await requestActor(req);
  if (!actor) return SIGN_IN_REQUIRED;
  if (!actor.studio) return STUDIO_ONLY;
  return { actor, sessionId: actor.studio.id, account: accountOf(actor, null) };
}

/** The JSON response for a refusal, never cached. */
export function refusalResponse(refusal: Refusal, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ code: refusal.code, error: refusal.error }, { status: refusal.status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function isRefusal<T extends object>(result: T | Refusal): result is Refusal {
  return !("sessionId" in result);
}
