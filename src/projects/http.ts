/** POST /api/projects creates a project; PUT /api/quotes/{key}/draft saves its unsent V1. Only designers in the project's studio may call them. */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCaseKey } from "@/chat/cases";
import { appDb } from "@/db/shared";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { isSameOriginRequest } from "@/http/origin";
import { isRefusal, refusalResponse, studioScope } from "@/http/scope";
import { createProject, PROJECT_NAME_MAX, PROJECT_SUBTITLE_MAX } from "./create";
import { DraftError, draftSchema, saveDraft, type DraftInput } from "./draft";

const headers = { "Cache-Control": "no-store" };
const schema = z.strictObject({
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
  subtitle: z.string().trim().max(PROJECT_SUBTITLE_MAX).optional().default(""),
});

export async function postProjectResponse(req: NextRequest) {
  if (!isSameOriginRequest(req)) return NextResponse.json({ code: "FORBIDDEN", error: "Create projects from this app's pages." }, { status: 403, headers });
  const scope = await studioScope(req);
  if (isRefusal(scope)) return refusalResponse(scope.status === 403 ? { ...scope, error: "Only the studio's designers create projects." } : scope, headers);
  noteRequest(scope.sessionId);
  const ended = await refuseIfEnded(scope.sessionId);
  if (ended) return ended;
  const text = await req.text();
  if (text.length > 2_048) return NextResponse.json({ code: "INVALID_REQUEST", error: "The request is too large." }, { status: 413, headers });
  let input: z.infer<typeof schema>;
  try { input = schema.parse(JSON.parse(text)); }
  catch { return NextResponse.json({ code: "INVALID_REQUEST", error: `Name the project in at most ${PROJECT_NAME_MAX} characters.` }, { status: 400, headers }); }
  try {
    const key = await createProject(appDb(), scope.sessionId, scope.account.name, input);
    return NextResponse.json({ key, href: `/chats/${key}` }, { status: 201, headers });
  } catch {
    return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The project could not be created right now. Try again shortly." }, { status: 503, headers });
  }
}

const draftStatuses = { NOT_FOUND: 404, NOT_AVAILABLE: 409, STALE_DRAFT: 409 } as const;

export async function putQuoteDraftResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  if (!isSameOriginRequest(req)) return NextResponse.json({ code: "FORBIDDEN", error: "Edit the quote from this app's pages." }, { status: 403, headers });
  const scope = await studioScope(req);
  if (isRefusal(scope)) return refusalResponse(scope.status === 403 ? { ...scope, error: "Only the studio's designers edit the quote." } : scope, headers);
  noteRequest(scope.sessionId);
  const ended = await refuseIfEnded(scope.sessionId);
  if (ended) return ended;
  const text = await req.text();
  if (text.length > 600_000) return NextResponse.json({ code: "INVALID_REQUEST", error: "The quote is too large to save at once." }, { status: 413, headers });
  let input: DraftInput;
  try { input = draftSchema.parse(JSON.parse(text)); }
  catch (error) {
    const issue = error instanceof z.ZodError ? error.issues[0] : null;
    const where = issue?.path[0] === "lines" && typeof issue.path[1] === "number" ? `Line ${issue.path[1] + 1}: ` : "";
    return NextResponse.json({ code: "INVALID_REQUEST", error: `${where}check ${String(issue?.path.at(-1) ?? "the quote")}: ${issue?.message ?? "it could not be read."}` }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await saveDraft(appDb(), scope.sessionId, rawKey, input), { headers });
  } catch (error) {
    if (error instanceof DraftError) return NextResponse.json({ code: error.code, error: error.message }, { status: draftStatuses[error.code], headers });
    return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The quote could not be saved right now. Your edits are still on this page; try again." }, { status: 503, headers });
  }
}
