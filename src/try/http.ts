import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SandboxGuardError } from "@/config/paypalEnv";
import { createDb } from "@/db/client";
import { isSameOriginRequest } from "@/http/origin";
import { DEMO_SESSION_COOKIE as SESSION_COOKIE, DEMO_VISITOR_COOKIE as VISITOR_COOKIE, privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { refreshDemoCookies } from "@/http/demo-cookies";
import { paypalLinks } from "@/payments/http";
import { sandboxPayPal, sandboxTestCard } from "@/payments/server";
import { MAPLE_SCENARIO, TRY_PROJECT_HREF, openWillowWorkspace, prepareTry, readTryRuns, readTrySeed, resumeTry, startTry } from "./service";

const uuid = z.uuid();
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const startSchema = z.union([
  z.strictObject({ action: z.literal("start").optional(), scenario: z.literal("maple-mixed-change-v1").optional(), restart: z.boolean().optional() }),
  z.strictObject({ action: z.literal("prepare"), runId: uuid }),
  z.strictObject({ action: z.literal("resume"), runId: uuid }),
  z.strictObject({ action: z.literal("workspace"), scenario: z.literal("willow-first-payment-v1") }),
]);
const database = globalThis as typeof globalThis & { settiChatDatabase?: ReturnType<typeof createDb> };
function db() {
  database.settiChatDatabase ??= createDb();
  return database.settiChatDatabase.db;
}
function identity(req: NextRequest, name: string): string | null {
  const parsed = uuid.safeParse(req.cookies.get(name)?.value);
  return parsed.success ? parsed.data : null;
}
function perHour(): number {
  const raw = process.env.SETTI_TRY_PER_HOUR?.trim(), value = raw ? Number(raw) : 30;
  return Number.isInteger(value) && value >= 0 ? value : 30;
}
const failure = (code: string, error: string, status: number) => NextResponse.json({ code, error }, { status, headers });
function retainIdentity(response: NextResponse, req: NextRequest, session: string, visitorId: string) {
  const options = privateDemoCookieOptions(req.nextUrl.protocol);
  response.cookies.set(SESSION_COOKIE, session, options);
  response.cookies.set(VISITOR_COOKIE, visitorId, options);
  return refreshDemoCookies(response, req);
}
async function state(session: string | null, visitorId: string | null, href = TRY_PROJECT_HREF) {
  const [seed, previousRuns] = await Promise.all([readTrySeed(db(), session), readTryRuns(db(), visitorId, session)]);
  return { seed, href, previousRuns, hasWorkspace: !!session, scenario: seed?.scenario ?? MAPLE_SCENARIO };
}
export async function getTryResponse(req: NextRequest) {
  try { return refreshDemoCookies(NextResponse.json(await state(identity(req, SESSION_COOKIE), identity(req, VISITOR_COOKIE)), { headers }), req); }
  catch { return failure("STORAGE_UNAVAILABLE", "Demo storage is unavailable. Make sure the database is running and migrated.", 503); }
}
export async function postTryResponse(req: NextRequest) {
  if (!isSameOriginRequest(req)) return failure("FORBIDDEN", "Start the demo from this app's /try page.", 403);
  const text = await req.text();
  if (text.length > 1_024) return failure("INVALID_REQUEST", "The request is too large.", 413);
  let body: z.infer<typeof startSchema>;
  try { body = startSchema.parse(text ? JSON.parse(text) : {}); }
  catch { return failure("INVALID_REQUEST", "Choose a supported demo action and scenario.", 400); }
  const current = identity(req, SESSION_COOKIE), visitorId = identity(req, VISITOR_COOKIE);
  try {
    if (body.action === "workspace") {
      const session = await openWillowWorkspace(db(), current), visitor = visitorId ?? randomUUID();
      return retainIdentity(NextResponse.json({ ...await state(session, visitor, "/quotes/willow"), reused: !!current }, { headers }), req, session, visitor);
    }
    if (body.action === "resume") {
      const seed = await resumeTry(db(), visitorId, body.runId);
      if (!seed || !visitorId) return failure("NOT_FOUND", "This run does not belong to this browser's saved visitor.", 404);
      return retainIdentity(NextResponse.json({ ...await state(seed.runId, visitorId), reused: true }, { headers }), req, seed.runId, visitorId);
    }
    if (body.action === "prepare") {
      if (!current || current !== body.runId) return failure("FORBIDDEN", "Resume this private run before preparing it.", 403);
      const result = await prepareTry({ db: db(), paypal: sandboxPayPal(), testCard: sandboxTestCard(), links: paypalLinks(req), perHour: perHour() }, current, body.runId);
      if (result.kind === "not_found") return failure("NOT_FOUND", "This preparation run could not be found.", 404);
      const payload = await state(current, visitorId);
      return NextResponse.json({ ...payload, ...(result.kind === "failed" ? { code: "SEED_FAILED", error: result.seed.error } : {}) }, { status: result.kind === "ready" ? 200 : result.kind === "failed" ? 502 : 202, headers });
    }
    const result = await startTry({ db: db(), perHour: perHour() }, current, { restart: body.restart, visitorId: visitorId ?? randomUUID() });
    if (result.kind === "limited") return failure("LIMITED", "The demo has prepared many projects in the last hour. Try again in a few minutes.", 429);
    return retainIdentity(NextResponse.json({ ...await state(result.session, result.visitorId), reused: result.reused }, { status: result.kind === "ready" ? 200 : 202, headers }), req, result.session, result.visitorId);
  } catch (error) {
    if (error instanceof SandboxGuardError) return failure("PAYPAL_NOT_CONFIGURED", "PayPal Sandbox is not configured on this server.", 503);
    return failure("STORAGE_UNAVAILABLE", "The saved run could not be read or advanced. Reload to check the same run before retrying.", 503);
  }
}
