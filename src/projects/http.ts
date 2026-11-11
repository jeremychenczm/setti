/** POST /api/projects: a studio's designer creates a project. */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appDb } from "@/db/shared";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { isSameOriginRequest } from "@/http/origin";
import { isRefusal, refusalResponse, studioScope } from "@/http/scope";
import { createProject, PROJECT_NAME_MAX, PROJECT_SUBTITLE_MAX } from "./create";

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
