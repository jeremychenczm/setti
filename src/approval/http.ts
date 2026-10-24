import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, accountOrDefault, clientOf } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { holdItemsAfterConfirmation } from "@/payments/http";
import { approvalStore } from "./server";
import { ApprovalStoreError } from "./store";
import type { ApprovalWorkspace } from "./types";

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

/** Only the project's client account confirms a version; anyone else in the session reads it. */
function notTheClient(req: NextRequest, key: CaseKey): string | null {
  const account = accountOrDefault(req.cookies.get(ACCOUNT_COOKIE)?.value);
  const client = clientOf(key);
  return account.id === client.id ? null : `Signed in as ${account.name}. Switch to ${client.name} from the avatar at the bottom left of the chat to confirm this version.`;
}

function asViewer(req: NextRequest, workspace: ApprovalWorkspace): ApprovalWorkspace {
  const refusal = workspace.canDecide ? notTheClient(req, workspace.view.order.projectKey) : null;
  return refusal ? { ...workspace, canDecide: false, reason: refusal } : workspace;
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (req.headers.get("origin") !== req.nextUrl.origin) throw new HttpError("The client decision must be submitted from this app's page.", 403);
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError("The request must be JSON.", 415);
  if (!req.body) throw new HttpError("Enter the client decision.", 400);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) { await reader.cancel(); throw new HttpError("The confirmation is too long. Shorten the note.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("The confirmation is not valid JSON.", 400); }
}

function fail(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ code: "INVALID_REQUEST", error: error.message }, { status: error.status, headers });
  if (error instanceof z.ZodError) return NextResponse.json({ code: "INVALID_REQUEST", error: "Check the version, the whole-order confirmation option, the client name and the note." }, { status: 400, headers });
  if (error instanceof ApprovalStoreError) {
    const statuses: Record<string, number> = { FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400, CONTENT_CHANGED: 409, DECISION_CONFLICT: 409, CASE_BUSY: 409, STALE_VERSION: 409 };
    return NextResponse.json({ code: error.code, error: error.message }, { status: statuses[error.code] ?? 400, headers });
  }
  return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The client decision cannot be read or saved right now. Check the saved state, then try again." }, { status: 503, headers });
}

export async function getApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  try {
    const workspace = await approvalStore().getWorkspace(session(req), id);
    return workspace ? NextResponse.json(asViewer(req, workspace), { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  } catch (error) { return fail(error); }
}

export async function postApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  const sessionId = session(req);
  if (!sessionId) return NextResponse.json({ code: "FORBIDDEN", error: "This shared link is view-only. Confirm from the demo session that owns the project." }, { status: 403, headers });
  try {
    const input = schema.parse(await boundedJson(req));
    const current = await approvalStore().getWorkspace(sessionId, id);
    if (!current) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
    const refusal = notTheClient(req, current.view.order.projectKey);
    if (refusal) return NextResponse.json({ code: "FORBIDDEN", error: refusal }, { status: 403, headers });
    const decided = await approvalStore().decide(sessionId, id, input);
    if (decided.view.decision?.decision === "approved") await holdItemsAfterConfirmation(sessionId, current.view.order.projectKey, req);
    return NextResponse.json(asViewer(req, decided), { headers });
  } catch (error) { return fail(error); }
}
