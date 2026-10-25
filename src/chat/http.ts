import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, accountOrDefault, canOpenProject, findAccount } from "@/accounts/demo";
import { aiConfigured } from "@/ai/model";
import { isAiInvocation } from "@/ai/intent";
import { isSameOriginRequest } from "@/http/origin";
import { privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { defaultOpening } from "@/opening/document";
import { openingStore } from "@/opening/server";
import { OpeningStoreError } from "@/opening/store";
import { DECLINE_REASON_MAX, QUOTE_MESSAGE_MAX } from "@/opening/types";
import { isCaseKey, preapprovedQuote } from "./cases";
import { chatStore } from "./server";
import { CaseAiError, runCaseAi } from "./service";
import type { CaseKey, CaseSnapshot, HumanActor, StoredCase } from "./types";

const cookieName = "setti-demo-chat";
const uuid = z.uuid();
const messageSchema = z.strictObject({ id: uuid, actor: z.enum(["designer", "client"]), text: z.string().trim().min(1).max(8000), aboutItemId: z.string().min(1).max(100).optional() });
const retrySchema = z.strictObject({ messageId: uuid });
const quoteSchema = z.strictObject({ id: uuid, text: z.string().trim().min(1).max(QUOTE_MESSAGE_MAX) });
const signSchema = z.strictObject({
  signingId: uuid,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().max(160),
  acknowledged: z.literal(true),
  decisions: z.array(z.strictObject({ itemId: z.string().min(1).max(100), decision: z.enum(["approved", "declined"]), note: z.string().max(DECLINE_REASON_MAX).optional() })).min(1).max(200),
});
const dropSchema = z.strictObject({ itemId: z.string().min(1).max(100) });

/** A client account sees that a draft is being prepared, never the designer's draft itself. */
function snapshot(state: StoredCase, req: NextRequest): CaseSnapshot {
  const base = { ...state, quote: state.quote ?? preapprovedQuote(state.projectKey), opening: state.opening ?? defaultOpening(state.projectKey), aiConfigured: aiConfigured() };
  // A draft already sent as a version is no longer being prepared.
  const preparing = !!state.draft && !state.versions?.some((version) => version.fromCurrentDraft);
  return findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value)?.role === "client" ? { ...base, draft: null, draftPreparing: preparing } : base;
}

function session(req: NextRequest): string {
  const parsed = uuid.safeParse(req.cookies.get(cookieName)?.value);
  return parsed.success ? parsed.data : randomUUID();
}

function respond(req: NextRequest, sessionId: string, body: unknown, status = 200) {
  const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  response.cookies.set(cookieName, sessionId, privateDemoCookieOptions(req.nextUrl.protocol));
  return response;
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("The request must be JSON.", 415);
  if (!isSameOriginRequest(req)) throw new HttpError("Chat writes from other sites are not accepted.", 403);
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
  try { return respond(req, sessionId, snapshot(await chatStore().getCase(sessionId, rawKey), req)); }
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
      if (!isAiInvocation(input.text)) return respond(req, sessionId, snapshot(state, req));
      messageId = input.id;
    }
    const state = await runCaseAi(store, sessionId, rawKey, messageId);
    return respond(req, sessionId, snapshot(state, req));
  } catch (error) {
    let state: CaseSnapshot | undefined;
    if (persisted) {
      try { state = snapshot(await chatStore().getCase(sessionId, rawKey as CaseKey), req); } catch { /* Original error remains authoritative. */ }
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

/** The designer posts the prepared V1 to the project chat. The server freezes its own copy; the request carries only the message. */
export async function postQuoteResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  try {
    const input = quoteSchema.parse(await boundedJson(req));
    const refusal = accountRefusal(req, rawKey);
    if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
    const account = accountOrDefault(req.cookies.get(ACCOUNT_COOKIE)?.value);
    if (account.role !== "designer") return respond(req, sessionId, { code: "FORBIDDEN", error: "Only the designer can send a quote." }, 403);
    const sentBy = account.name;
    return respond(req, sessionId, snapshot(await chatStore().sendQuote(sessionId, rawKey, { ...input, sentBy }), req));
  } catch (error) {
    if (error instanceof HttpError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: error.message }, error.status);
    if (error instanceof z.ZodError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: `Send the quote with a message of at most ${QUOTE_MESSAGE_MAX.toLocaleString("en-US")} characters.` }, 400);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "STORAGE_UNAVAILABLE";
    const known: Record<string, [number, string]> = {
      NOT_AVAILABLE: [409, "This project starts from a quote the client already approved, so there is nothing to send."],
      CASE_BUSY: [409, "The AI is working on this project. Send the quote again shortly."],
      IDEMPOTENCY_CONFLICT: [409, "This send was already used for another message. Reload the chat and try again."],
      INVALID_INPUT: [400, "Send the quote with a short message to the client."],
    };
    const [status, message] = known[code] ?? [503, "Chat storage is unavailable. Check the database and migrations."];
    return respond(req, sessionId, { code: known[code] ? code : "STORAGE_UNAVAILABLE", error: message }, status);
  }
}

/** The quote report: the designer sees a draft V1, a client only what was sent to them. */
export async function getQuoteResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  const refusal = accountRefusal(req, rawKey);
  if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
  try {
    const view = await chatStore().getQuote(sessionId, rawKey);
    if (findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value)?.role === "client" && view.opening.status === "draft") {
      return respond(req, sessionId, { code: "NOT_SHARED", error: "The designer has not sent this quote yet." }, 404);
    }
    return respond(req, sessionId, view);
  } catch {
    return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "Quote storage is unavailable. Make sure the database is running and migrated." }, 503);
  }
}

const openingStatuses: Record<string, number> = { INVALID_INPUT: 400, FORBIDDEN: 403, NOT_AVAILABLE: 409, NOT_SENT: 409, CONTENT_CHANGED: 409, CLOSED: 409, CASE_BUSY: 409, ALREADY_DECIDED: 409 };

function openingFailure(req: NextRequest, sessionId: string, error: unknown, invalid: string) {
  if (error instanceof HttpError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: error.message }, error.status);
  if (error instanceof z.ZodError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: invalid }, 400);
  if (error instanceof OpeningStoreError && openingStatuses[error.code]) return respond(req, sessionId, { code: error.code, error: error.message }, openingStatuses[error.code]);
  return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "Quote storage is unavailable. Make sure the database is running and migrated." }, 503);
}

/** The client signs the lines they decide now. Only the project's own client account may sign. */
export async function postQuoteSignResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  try {
    const input = signSchema.parse(await boundedJson(req));
    const account = findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value);
    if (account?.role !== "client" || !canOpenProject(account, rawKey)) return respond(req, sessionId, { code: "FORBIDDEN", error: "Only the client can sign quote V1. Switch to the client's account first." }, 403);
    return respond(req, sessionId, await openingStore().sign(sessionId, rawKey, input));
  } catch (error) {
    return openingFailure(req, sessionId, error, "Choose at least one line, confirm you reviewed the quote and type your name.");
  }
}

/** The designer drops a V1 line the client declined or left undecided. */
export async function postQuoteDropResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  try {
    const { itemId } = dropSchema.parse(await boundedJson(req));
    const refusal = accountRefusal(req, rawKey);
    if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
    const account = accountOrDefault(req.cookies.get(ACCOUNT_COOKIE)?.value);
    if (account.role !== "designer") return respond(req, sessionId, { code: "FORBIDDEN", error: "Only the designer can drop a line from quote V1." }, 403);
    return respond(req, sessionId, await openingStore().drop(sessionId, rawKey, { itemId, by: account.name }));
  } catch (error) {
    return openingFailure(req, sessionId, error, "Choose the quote line to drop.");
  }
}

/** The designer revises a declined V1 line by hand; the pricing page opens on the draft that now carries it. */
export async function postQuoteReviseResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  const sessionId = session(req);
  try {
    const { itemId } = dropSchema.parse(await boundedJson(req));
    const refusal = accountRefusal(req, rawKey);
    if (refusal) return respond(req, sessionId, { code: "FORBIDDEN", error: refusal }, 403);
    if (accountOrDefault(req.cookies.get(ACCOUNT_COOKIE)?.value).role !== "designer") return respond(req, sessionId, { code: "FORBIDDEN", error: "Only the designer can revise a quote line." }, 403);
    const { draft } = await openingStore().revise(sessionId, rawKey, { itemId });
    return respond(req, sessionId, { href: `/pricing/${rawKey}`, draftId: draft.id, revision: draft.revision });
  } catch (error) {
    return openingFailure(req, sessionId, error, "Choose the declined quote line to revise.");
  }
}
