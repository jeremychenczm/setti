import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_COOKIE, findAccount } from "@/accounts/demo";
import { isCaseKey } from "@/chat/cases";
import { isSameOriginRequest } from "@/http/origin";
import { privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { pricingInputSchema, PricingValidationError } from "./calculation";
import { pricingDb, pricingStore } from "./server";
import { startLineChange } from "./line-change";
import { PricingStoreError } from "./store";

const uuid = z.uuid();
const saveSchema = z.strictObject({
  sourceDraftId: uuid,
  sourceDraftRevision: z.number().int().positive(),
  expectedVersion: z.number().int().positive().nullable(),
  input: pricingInputSchema,
});
const issueSchema = z.strictObject({ reviewId: uuid, expectedVersion: z.number().int().positive() });
const cents = z.number().int().min(0).max(2_000_000_000);
const lineSchema = z.strictObject({
  itemId: z.string().min(1).max(300),
  /** What the supplier's order confirmation states, when it differs from the line. */
  supplier: z.strictObject({
    reference: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(10_000),
    unitPriceCents: cents, taxCents: cents, freightCents: cents, leadTimeDays: z.number().int().min(0).max(3_650).nullable(),
  }).optional(),
});
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/** Pricing is the designer's work in progress; a client account sees the change order once it is issued. */
function clientRefusal(req: NextRequest, session: string) {
  return findAccount(req.cookies.get(ACCOUNT_COOKIE)?.value)?.role === "client"
    ? respond(req, session, { code: "FORBIDDEN", error: "Only the designer can open the pricing review." }, 403) : null;
}

function sessionId(req: NextRequest): string {
  const parsed = uuid.safeParse(req.cookies.get("setti-demo-chat")?.value);
  if (!parsed.success) return randomUUID();
  noteRequest(parsed.data);
  return parsed.data;
}

function respond(req: NextRequest, session: string, body: unknown, status = 200) {
  const response = NextResponse.json(body, { status, headers });
  response.cookies.set("setti-demo-chat", session, privateDemoCookieOptions(req.nextUrl.protocol));
  return response;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function boundedJson(req: NextRequest): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new RequestError("The request must be JSON.", 415);
  if (!isSameOriginRequest(req)) throw new RequestError("Pricing changes from other sites are not accepted.", 403);
  if (!req.body) throw new RequestError("The pricing request is empty.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 262_144) { await reader.cancel(); throw new RequestError("The pricing request is too long. Shorten the notes or terms.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("The pricing request is not valid JSON.", 400); }
}

function failure(req: NextRequest, session: string, error: unknown) {
  if (error instanceof RequestError) return respond(req, session, { code: "INVALID_REQUEST", error: error.message }, error.status);
  if (error instanceof z.ZodError) return respond(req, session, { code: "INVALID_REQUEST", error: "Some pricing fields are invalid. Check the amounts, quantities and version." }, 400);
  if (error instanceof PricingValidationError) return respond(req, session, { code: "PRICING_NOT_READY", error: error.message, problems: error.problems }, 422);
  if (error instanceof PricingStoreError) {
    const statuses: Record<string, number> = { PREPARATION_PENDING: 409, PRICING_CONFLICT: 409, PRICING_STALE_SOURCE: 409, PRICING_BUSY: 409, PRICING_NOT_FOUND: 404, PRICING_NOT_READY: 422, INVALID_INPUT: 400 };
    return respond(req, session, { code: error.code, error: error.message, problems: error.problems }, statuses[error.code] ?? 400);
  }
  return respond(req, session, { code: "STORAGE_UNAVAILABLE", error: "Pricing storage is unavailable. Check the database and migrations." }, 503);
}

export async function getPricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const session = sessionId(req);
  const refusal = clientRefusal(req, session);
  if (refusal) return refusal;
  try { return respond(req, session, await pricingStore().getWorkspace(session, rawKey)); }
  catch (error) { return failure(req, session, error); }
}

export async function savePricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const session = sessionId(req);
  const refusal = clientRefusal(req, session);
  if (refusal) return refusal;
  const ended = await refuseIfEnded(session);
  if (ended) return ended;
  try {
    const input = saveSchema.parse(await boundedJson(req));
    return respond(req, session, await pricingStore().saveReview(session, rawKey, input));
  } catch (error) { return failure(req, session, error); }
}

export async function issuePricingResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const session = sessionId(req);
  const refusal = clientRefusal(req, session);
  if (refusal) return refusal;
  const ended = await refuseIfEnded(session);
  if (ended) return ended;
  try {
    const input = issueSchema.parse(await boundedJson(req));
    return respond(req, session, await pricingStore().issueReview(session, rawKey, input));
  } catch (error) { return failure(req, session, error); }
}

/** The designer changes a line of the current agreement; the pricing page opens on the draft that now carries it. */
export async function postLineChangeResponse(req: NextRequest, rawKey: string) {
  if (!isCaseKey(rawKey)) return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404, headers });
  const session = sessionId(req);
  const refusal = clientRefusal(req, session);
  if (refusal) return refusal;
  const ended = await refuseIfEnded(session);
  if (ended) return ended;
  try {
    const { draft } = await startLineChange(pricingDb(), session, rawKey, lineSchema.parse(await boundedJson(req)));
    return respond(req, session, { href: `/pricing/${rawKey}`, draftId: draft.id, revision: draft.revision });
  } catch (error) { return failure(req, session, error); }
}

/** A random document id is a read-only share link; no write endpoint uses it. */
export async function getChangeOrderResponse(_req: NextRequest, id: string) {
  if (!uuid.safeParse(id).success) return NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  try {
    const view = await pricingStore().getOrder(id);
    return view ? NextResponse.json(view, { headers }) : NextResponse.json({ code: "NOT_FOUND", error: "Change order not found." }, { status: 404, headers });
  } catch {
    return NextResponse.json({ code: "STORAGE_UNAVAILABLE", error: "The change order cannot be read right now. Try again shortly." }, { status: 503, headers });
  }
}
