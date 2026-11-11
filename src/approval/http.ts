/**
 * GET and POST /api/change-orders/{id}/approval. Anyone with the link reads the
 * frozen version; only the project's client, signed in, confirms it.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientOf } from "@/accounts/demo";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { orderScope, type OrderScope } from "@/http/order-scope";
import { isSameOriginRequest } from "@/http/origin";
import { NOT_YOUR_PROJECT, SIGN_IN_REQUIRED } from "@/http/scope";
import { afterClientConfirmed } from "@/payments/http";
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

/** A signed-in actor's standing on one change order: the studio its data lives in, and why they may not confirm it. */
interface Standing { studioId: string; refusal: string | null }

function standing({ actor, owner, account }: OrderScope): Standing | null {
  if (!actor || !owner || !account) return null;
  noteRequest(owner.studioId);
  // A demo visitor plays both sides, so the refusal names the demo person to switch to.
  const refusal = account.role === "client" ? null : actor.demoPersona
    ? `Signed in as ${account.name}. Switch to ${clientOf(owner.key)?.name ?? "the client"} from the avatar at the bottom left of the chat to confirm this version.`
    : `Signed in as ${account.name}, a designer. Only the project's client confirms this version.`;
  return { studioId: owner.studioId, refusal };
}

function asViewer(workspace: ApprovalWorkspace, viewer: Standing | null): ApprovalWorkspace {
  const refusal = workspace.canDecide ? viewer?.refusal : null;
  return refusal ? { ...workspace, canDecide: false, reason: refusal } : workspace;
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!isSameOriginRequest(req)) throw new HttpError("The client decision must be submitted from this app's page.", 403);
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
    const statuses: Record<string, number> = { PREPARATION_PENDING: 409, FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400, CONTENT_CHANGED: 409, DECISION_CONFLICT: 409, CASE_BUSY: 409, STALE_VERSION: 409 };
    return NextResponse.json({ code: error.code, error: error.message }, { status: statuses[error.code] ?? 400, headers });
  }
  return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The client decision cannot be read or saved right now. Check the saved state, then try again." }, { status: 503, headers });
}

export async function getApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  try {
    const viewer = standing(await orderScope(req, id));
    const workspace = await approvalStore().getWorkspace(viewer?.studioId ?? null, id);
    return workspace ? NextResponse.json(asViewer(workspace, viewer), { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  } catch (error) { return fail(error); }
}

export async function postApprovalResponse(req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  try {
    const scope = await orderScope(req, id);
    if (!scope.actor) return NextResponse.json({ code: SIGN_IN_REQUIRED.code, error: SIGN_IN_REQUIRED.error }, { status: SIGN_IN_REQUIRED.status, headers });
    const input = schema.parse(await boundedJson(req));
    const viewer = standing(scope);
    if (!viewer) return NextResponse.json({ code: NOT_YOUR_PROJECT.code, error: NOT_YOUR_PROJECT.error }, { status: NOT_YOUR_PROJECT.status, headers });
    const ended = await refuseIfEnded(viewer.studioId);
    if (ended) return ended;
    if (viewer.refusal) return NextResponse.json({ code: "FORBIDDEN", error: viewer.refusal }, { status: 403, headers });
    const current = await approvalStore().getWorkspace(viewer.studioId, id);
    if (!current) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
    const decided = await approvalStore().decide(viewer.studioId, id, input);
    // The confirmation is saved first; a failed hold or hand-off after it does not undo it, and the payments panel offers the holds by hand.
    if (decided.view.decision?.decision === "approved") await afterClientConfirmed(req, viewer.studioId, current.view.order.projectKey, id).catch(() => undefined);
    return NextResponse.json(asViewer(decided, viewer), { headers });
  } catch (error) { return fail(error); }
}
