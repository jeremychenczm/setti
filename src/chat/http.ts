import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { aiConfigured } from "@/ai/model";
import { isAiInvocation } from "@/ai/intent";
import { caseQuote, isCaseKey } from "./cases";
import { chatStore } from "./server";
import { CaseAiError, runCaseAi } from "./service";
import type { CaseKey, CaseSnapshot, StoredCase } from "./types";

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
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("请求需要 JSON 格式。", 415);
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) throw new HttpError("不接受来自其他站点的聊天写入。", 403);
  if (!req.body) throw new HttpError("消息不能为空。", 400);
  const reader = req.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) { await reader.cancel(); throw new HttpError("消息过长，请控制在 8000 字符内。", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("无法解析消息 JSON。", 400); }
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function getCaseResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "项目不存在。" }, { status: 404 });
  const sessionId = session(req);
  try { return respond(req, sessionId, snapshot(await chatStore().getCase(sessionId, rawKey))); }
  catch { return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "聊天存储暂不可用，请确认数据库已启动并执行迁移。" }, 503); }
}

export async function postCaseResponse(req: NextRequest, rawKey: string, retry = false) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "项目不存在。" }, { status: 404 });
  const sessionId = session(req);
  let persisted = false;
  try {
    const body = await boundedJson(req);
    const store = chatStore();
    let messageId: string;
    if (retry) {
      messageId = retrySchema.parse(body).messageId;
      persisted = true;
    } else {
      const input = messageSchema.parse(body);
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
    if (error instanceof z.ZodError) return respond(req, sessionId, { code: "INVALID_REQUEST", error: "消息格式错误：需要有效 ID、发言身份和不超过 8000 字符的正文。", state }, 400);
    if (error instanceof CaseAiError) return respond(req, sessionId, { code: "AI_FAILED", error: error.message, state }, 502);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "STORAGE_UNAVAILABLE";
    const statuses: Record<string, number> = { CASE_BUSY: 409, IDEMPOTENCY_CONFLICT: 409, MESSAGE_NOT_FOUND: 404, INVALID_AI_TRIGGER: 400, STALE_AI_RUN: 409, STALE_MESSAGE: 409, STALE_BASELINE: 409, INVALID_INPUT: 400 };
    if (statuses[code]) {
      const message = code === "CASE_BUSY" ? "AI 正在处理当前项目，请稍后重试。" : code === "MESSAGE_NOT_FOUND" ? "找不到本项目中的这条消息。" : code === "STALE_MESSAGE" ? "项目中已有更新的讨论。请发送一条新的 @AI 指令，避免旧消息覆盖当前意图。" : code === "STALE_BASELINE" ? "客户已确认新的报价版本。请发送新的 @AI 指令，按最新已确认版本起草。" : "消息状态已变化或请求无效，请刷新后重试。";
      return respond(req, sessionId, { code, error: message, state }, statuses[code]);
    }
    return respond(req, sessionId, { code: "STORAGE_UNAVAILABLE", error: "聊天存储暂不可用，请确认数据库与迁移状态。", state }, 503);
  }
}
