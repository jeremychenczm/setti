import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, accountOrDefault } from "@/accounts/demo";
import { DEMO_SESSION_COOKIE, privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { aiConfigured } from "@/ai/model";
import { createDb } from "@/db/client";
import { studioCase } from "@/demo/studio-cases";
import { isSameOriginRequest } from "@/http/origin";
import { callStudioModel } from "./model";
import { StudioChatError, studioThreadStore } from "./store";
import type { StudioThreadSnapshot } from "./types";

const inputSchema = z.strictObject({ id: z.uuid(), text: z.string().trim().min(1).max(8000) });
const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function store() { database.settiChatDatabase ??= createDb(); return studioThreadStore(database.settiChatDatabase.db); }

export async function studioChatResponse(req: NextRequest, id: string) {
  const project = studioCase(id);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  if (accountOrDefault(req.cookies.get(ACCOUNT_COOKIE)?.value).role !== "designer") return NextResponse.json({ error: "This project belongs to the designer's studio." }, { status: 403 });
  const cookie = z.uuid().safeParse(req.cookies.get(DEMO_SESSION_COOKIE)?.value);
  const session = cookie.success ? cookie.data : randomUUID();
  const response = (body: unknown, status = 200) => {
    const res = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
    res.cookies.set(DEMO_SESSION_COOKIE, session, privateDemoCookieOptions(req.nextUrl.protocol));
    return res;
  };
  const snapshot = (messages: StudioThreadSnapshot["messages"]): StudioThreadSnapshot => ({ projectId: project.id, messages, readOnly: project.stage === "settled", aiConfigured: aiConfigured() });
  try {
    if (req.method === "GET") return response(snapshot(await store().read(session, project)));
    if (!isSameOriginRequest(req)) return response({ error: "Messages from another site are not accepted." }, 403);
    if (!req.headers.get("content-type")?.startsWith("application/json")) return response({ error: "Send a JSON message." }, 415);
    if (!req.body) return response({ error: "The message is empty." }, 400);
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) { await reader.cancel(); return response({ error: "Keep your message under 8,000 characters." }, 413); }
      chunks.push(value);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return response({ error: "The message could not be read." }, 400); }
    const input = inputSchema.parse(body);
    const saved = await store().append(session, project, input);
    if (!saved.runId) return response(snapshot(saved.messages));
    let result: Awaited<ReturnType<typeof callStudioModel>>;
    try { result = await callStudioModel(project, saved.messages); }
    catch {
      const error = "AI could not complete this request. Your message is saved; retry it when ready.";
      const messages = await store().finish(session, project, input.id, saved.runId, { error });
      return response({ error, state: snapshot(messages) }, 502);
    }
    return response(snapshot(await store().finish(session, project, input.id, saved.runId, result)));
  } catch (error) {
    if (error instanceof StudioChatError) return response({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return response({ error: "Send a message of 1–8,000 characters with a valid message ID." }, 400);
    return response({ error: "Conversation storage is unavailable. Refresh and retry; keep your message until it is saved." }, 503);
  }
}
