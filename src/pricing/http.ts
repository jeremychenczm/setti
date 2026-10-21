import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCaseKey } from "@/chat/cases";
import { pricingInputSchema, PricingValidationError } from "./calculation";
import { pricingStore } from "./server";
import { PricingStoreError } from "./store";

const uuid = z.uuid();
const saveSchema = z.strictObject({
  sourceDraftId: uuid,
  sourceDraftRevision: z.number().int().positive(),
  expectedVersion: z.number().int().positive().nullable(),
  input: pricingInputSchema,
});
const issueSchema = z.strictObject({ reviewId: uuid, expectedVersion: z.number().int().positive() });
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function sessionId(req: NextRequest): string {
  const parsed = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  return parsed.success ? parsed.data : randomUUID();
}

function respond(req: NextRequest, session: string, body: unknown, status = 200) {
  const response = NextResponse.json(body, { status, headers });
  response.cookies.set("setti-demo-chat", session, {
    httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30,
    secure: req.nextUrl.protocol === "https:",
  });
  return response;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new RequestError("请求需要 JSON 格式。", 415);
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) throw new RequestError("不接受其他站点发起的核价修改。", 403);
  if (!req.body) throw new RequestError("核价内容不能为空。", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 262_144) { await reader.cancel(); throw new RequestError("核价内容过长，请精简备注或条款。", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("核价内容不是有效的 JSON。", 400); }
}

function failure(req: NextRequest, session: string, error: unknown) {
  if (error instanceof RequestError) return respond(req, session, { code: "INVALID_REQUEST", error: error.message }, error.status);
  if (error instanceof z.ZodError) return respond(req, session, { code: "INVALID_REQUEST", error: "核价字段格式错误，请核对金额、数量和版本。" }, 400);
  if (error instanceof PricingValidationError) return respond(req, session, { code: "PRICING_NOT_READY", error: error.message, problems: error.problems }, 422);
  if (error instanceof PricingStoreError) {
    const statuses: Record<string, number> = { PRICING_CONFLICT: 409, PRICING_STALE_SOURCE: 409, PRICING_BUSY: 409, PRICING_NOT_FOUND: 404, PRICING_NOT_READY: 422, INVALID_INPUT: 400 };
    return respond(req, session, { code: error.code, error: error.message, problems: error.problems }, statuses[error.code] ?? 400);
  }
  return respond(req, session, { code: "STORAGE_UNAVAILABLE", error: "核价存储暂不可用，请检查数据库和迁移状态。" }, 503);
}

export async function getPricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "项目不存在。" }, { status: 404, headers });
  const session = sessionId(req);
  try { return respond(req, session, await pricingStore().getWorkspace(session, rawKey)); }
  catch (error) { return failure(req, session, error); }
}

export async function savePricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "项目不存在。" }, { status: 404, headers });
  const session = sessionId(req);
  try {
    const input = saveSchema.parse(await boundedJson(req));
    return respond(req, session, await pricingStore().saveReview(session, rawKey, input));
  } catch (error) { return failure(req, session, error); }
}

export async function issuePricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "项目不存在。" }, { status: 404, headers });
  const session = sessionId(req);
  try {
    const input = issueSchema.parse(await boundedJson(req));
    return respond(req, session, await pricingStore().issueReview(session, rawKey, input));
  } catch (error) { return failure(req, session, error); }
}

/** A random document id is a read-only share link; no write endpoint uses it. */
export async function getChangeOrderResponse(_req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "变更单不存在。" }, { status: 404, headers });
  try {
    const view = await pricingStore().getOrder(id);
    return view ? NextResponse.json(view, { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "变更单不存在。" }, { status: 404, headers });
  } catch {
    return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "暂时无法读取变更单，请稍后重试。" }, { status: 503, headers });
  }
}
