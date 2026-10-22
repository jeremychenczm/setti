import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, canOpenProject, findAccount } from "@/accounts/demo";
import { aiConfigured } from "@/ai/model";
import { isAiInvocation } from "@/ai/intent";
import { caseQuote, isCaseKey } from "./cases";
import { chatStore } from "./server";
import { CaseAiError, runCaseAi } from "./service";
import type { CaseKey, CaseSnapshot, HumanActor, StoredCase } from "./types";

const cookieName = "setti-demo-chat";
const uuid = z.uuid();
const messageSchema = z.strictObject({ id: uuid, actor: z.enum(["designer", "client"]), text: z.string().trim().min(1).max(8000) });
const retrySchema = z.strictObject({ messageId: uuid });

function snapshot(state: StoredCase): CaseSnapshot {
  return { ...state, quote: state.quote ?? caseQuote(state.projectKey), aiConfigured: aiConfigured() };
}

function session(req: NextRequest): string {
  const parsed = uuid.safeParse(req.cookies.get(cookieName)?.value);
  return parsed.success ? parsed.data : randomUUID();
}

function respond(req: NextRequest, sessionId: string, body: unknown, status = 200) {
  const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  response.cookies.set(cookieName, sessionId, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30,
    secure: req.nextUrl.protocol === "https:",
  });
  return response;
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("The request must be JSON.", 415);
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) throw new HttpError("Chat writes from other sites are not accepted.", 403);
  if (!req.body) throw new HttpError("The message is empty.", 400);
  const reader = req.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) { await reader.cancel(); throw new HttpError("The message is too long. Keep it under 8,000 characters.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("The message JSON could not be parsed.", 400); }
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * Once a demo account is chosen, it may open only its own projects and speak only
 * in its own role. A browser that never switched accounts, and API tests, are not
 * limited: the demo account is who is acting, not a login.
 */
function accountRefusal(req: NextRequest, key: CaseKey, actor?: HumanActor): string | null {
  const account = findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
  if (!account) return null;
  if (!canOpenProject(account, key)) return `${account.name} is not part of this project.`;
  if (actor && actor !== account.role) return `This browser is signed in as ${account.name}. Reload the chat to send as ${account.name}.`;
  return null;
}

export async function getCaseResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  const refusal = accountRefusal(req, rawKey);
  if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
  try { return respond(req, sessionId, snapshot(await chatStore().getCase(sessionId, rawKey))); }
  catch { return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "Chat storage is unavailable. Make sure the database is running and migrated." }, 503); }
}

export async function postCaseResponse(req: NextRequest, rawKey: string, retry = false) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  let persisted = false;
  try {
    const body = await boundedJson(req);
    const store = chatStore();
    let messageId: string;
    if (retry) {
      messageId = retrySchema.parse(body).messageId;
      const refusal = accountRefusal(req, rawKey);
      if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
      persisted = true;
    } else {
      const input = messageSchema.parse(body);
      const refusal = accountRefusal(req, rawKey, input.actor);
      if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
      const state = await store.appendMessage(sessionId, rawKey, input);
      persisted = true;
      if (!isAiInvocation(input.text)) return respond(req, sessionId, snapshot(state));
      messageId = input.id;
    }
    const state = await runCaseAi(store, sessionId, rawKey, messageId);
    return respond(req, sessionId, snapshot(state));
  } catch (error) {
    let state: CaseSnapshot | undefined;
    if (persisted) {
      try { state = snapshot(await chatStore().getCase(sessionId, rawKey as CaseKey)); } catch { /* Original error remains authoritative. */ }
    }
    if (error instanceof HttpError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: error.message, state }, error.status);
    if (error instanceof z.ZodError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: "Invalid message: it needs a valid ID, a speaker and text of no more than 8,000 characters.", state }, 400);
    if (error instanceof CaseAiError) return respond(req, sessionId, { code: "AI_FAILED", error: error.message, state }, 502);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "STORAGE_UNAVAILABLE";
    const statuses: Record<string, number> = { CASE_BUSY: 409, IDEMPOTENCY_CONFLICT: 409, MESSAGE_NOT_FOUND: 404, INVALID_AI_TRIGGER: 400, STALE_AI_RUN: 409, STALE_MESSAGE: 409, STALE_BASELINE: 409, INVALID_INPUT: 400 };
    if (statuses[code]) {
      const message = code === "CASE_BUSY" ? "The AI is working on this project. Try again shortly." : code === "MESSAGE_NOT_FOUND" ? "This message was not found in the project." : code === "STALE_MESSAGE" ? "The project has newer discussion. Send a new @AI request so an older message does not override the current intent." : code === "STALE_BASELINE" ? "The client confirmed a newer quote version. Send a new @AI request to draft from the latest confirmed version." : "The message state changed or the request is invalid. Refresh and try again.";
      return respond(req, sessionId, { code, error: message, state }, statuses[code]);
    }
    return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "Chat storage is unavailable. Check the database and migrations.", state }, 503);
  }
}
