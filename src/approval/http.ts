import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approvalStore } from "./server";
import { ApprovalStoreError } from "./store";

const uuid = z.uuid();
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const schema = z.strictObject({
  decision: z.enum(["approved", "changes_requested"]), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  revisionContentHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledged: z.literal(true),
  signature: z.string().trim().min(1).max(160), note: z.string().trim().max(3000),
});
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

function session(req: NextRequest): string | null {
  const parsed = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  return parsed.success ? parsed.data : null;
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (req.headers.get("origin") !== req.nextUrl.origin) throw new HttpError("客户决定需要从本应用页面提交。", 403);
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("请求需要 JSON 格式。", 415);
  if (!req.body) throw new HttpError("请填写客户决定。", 400);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new HttpError("确认内容过长，请精简备注。", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("确认内容不是有效的 JSON。", 400); }
}

function fail(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ code: "INVALID_REQUEST", error: error.message }, { status: error.status, headers });
  if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", error: "请检查版本、整份确认选项、客户姓名及备注。" }, { status: 400, headers });
  if (error instanceof ApprovalStoreError) {
    const statuses: Record<string, number> = { FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400, CONTENT_CHANGED: 409, DECISION_CONFLICT: 409, CASE_BUSY: 409, STALE_VERSION: 409 };
    return NextResponse.json({ code: error.code, error: error.message }, { status: statuses[error.code] ?? 400, headers });
  }
  return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "暂时无法读取或保存客户决定。请检查已保存状态后再重试。" }, { status: 503, headers });
}

export async function getApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "变更单不存在。" }, { status: 404, headers });
  try {
    const workspace = await approvalStore().getWorkspace(session(req), id);
    return workspace ? NextResponse.json(workspace, { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "变更单不存在。" }, { status: 404, headers });
  } catch (error) { return fail(error); }
}

export async function postApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "变更单不存在。" }, { status: 404, headers });
  const sessionId = session(req);
  if (!sessionId) return NextResponse.json({ code: "FORBIDDEN", error: "此分享链接只允许查看。请从项目所属的演示会话中确认。" }, { status: 403, headers });
  try {
    const input = schema.parse(await boundedJson(req));
    return NextResponse.json(await approvalStore().decide(sessionId, id, input), { headers });
  } catch (error) { return fail(error); }
}
