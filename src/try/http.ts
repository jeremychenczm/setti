import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SandboxGuardError } from "@/config/paypalEnv";
import { createDb } from "@/db/client";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { isSameOriginRequest } from "@/http/origin";
import { ACCOUNT_COOKIE } from "@/accounts/demo";
import { DEMO_SESSION_COOKIE as SESSION_COOKIE, DEMO_VISITOR_COOKIE as VISITOR_COOKIE, privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { refreshDemoCookies } from "@/http/demo-cookies";
import { paypalLinks } from "@/payments/http";
import { sandboxPayPal, sandboxTestCard } from "@/payments/server";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { demoEnd, endDemo, markDemoEnded } from "./activity";
import { TRY_PROJECT_HREF, openWillowWorkspace, prepareTry, readTryRuns, readTrySeed, resumeTry, startTry } from "./service";

const uuid = z.uuid();
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
// Only the current walkthrough starts. Retired scenarios wrote scripted "@AI" exchanges, so they stay out of the product.
const startSchema = z.union([
  z.strictObject({ action: z.literal("start").optional(), scenario: z.literal(HOME_SCENARIO).optional(), restart: z.boolean().optional() }),
  z.strictObject({ action: z.literal("prepare"), runId: uuid }),
  z.strictObject({ action: z.literal("resume"), runId: uuid }),
  z.strictObject({ action: z.literal("workspace"), scenario: z.literal("willow-first-payment-v1") }),
  z.strictObject({ action: z.literal("end") }),
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
  const [seed, previousRuns, demoEnded] = await Promise.all([readTrySeed(db(), session), readTryRuns(db(), visitorId, session), session ? demoEnd(db(), session).catch(() => null) : null]);
  return { seed, href, previousRuns, hasWorkspace: !!session, scenario: seed?.scenario ?? HOME_SCENARIO, demoEnded };
}
/**
 * End & reset ends the demo itself: it is recorded at once, and its holds are
 * released in the background (PayPal calls can take a while). Whatever is not
 * released yet, the next daily check releases.
 */
async function endOnReset(session: string) {
  try { await markDemoEnded(db(), session, "visitor"); } catch { return; }
  let paypal: ReturnType<typeof sandboxPayPal>;
  try { paypal = sandboxPayPal(); } catch { return; }
  void endDemo(db(), paypal, session, "visitor").catch(() => undefined);
}
export async function getTryResponse(req: NextRequest) {
  const session = identity(req, SESSION_COOKIE);
  noteRequest(session);
  try { return refreshDemoCookies(NextResponse.json(await state(session, identity(req, VISITOR_COOKIE)), { headers }), req); }
  catch { return failure("STORAGE_UNAVAILABLE", "Demo storage is unavailable. Make sure the database is running and migrated.", 503); }
}
export async function postTryResponse(req: NextRequest) {
  if (!isSameOriginRequest(req)) return failure("FORBIDDEN", "Start the demo from this app's /try page.", 403);
  const text = await req.text();
  if (text.length > 1_024) return failure("INVALID_REQUEST", "The request is too large.", 413);
  let body: z.infer<typeof startSchema>;
  try { body = startSchema.parse(text ? JSON.parse(text) : {}); }
  catch { return failure("INVALID_REQUEST", "Choose a supported demo action and scenario.", 400); }
  if (body.action === "end") {
    const ending = identity(req, SESSION_COOKIE);
    if (ending) await endOnReset(ending);
    const response = NextResponse.json({ reset: true, href: "/try" }, { headers });
    const options = { ...privateDemoCookieOptions(req.nextUrl.protocol), maxAge: 0, expires: new Date(0) };
    response.cookies.set(SESSION_COOKIE, "", options);
    response.cookies.set(VISITOR_COOKIE, "", options);
    response.cookies.set(ACCOUNT_COOKIE, "", { ...options, httpOnly: false });
    return response;
  }
  const current = identity(req, SESSION_COOKIE), visitorId = identity(req, VISITOR_COOKIE);
  noteRequest(current);
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
      const ended = await refuseIfEnded(current);
      if (ended) return ended;
      const saved = await readTrySeed(db(), current);
      if (saved && saved.scenario !== HOME_SCENARIO) return failure("RETIRED", "This older walkthrough can no longer be prepared. Start the current walkthrough from /try.", 410);
      const result = await prepareTry({ db: db(), paypal: sandboxPayPal(), testCard: sandboxTestCard(), links: paypalLinks(req), perHour: perHour() }, current, body.runId);
      if (result.kind === "not_found") return failure("NOT_FOUND", "This preparation run could not be found.", 404);
      const payload = await state(current, visitorId);
      return NextResponse.json({ ...payload, ...(result.kind === "failed" ? { code: "SEED_FAILED", error: result.seed.error } : {}) }, { status: result.kind === "ready" ? 200 : result.kind === "failed" ? 502 : 202, headers });
    }
    const result = await startTry({ db: db(), perHour: perHour() }, current, { restart: body.restart, visitorId: visitorId ?? randomUUID(), scenario: HOME_SCENARIO });
    if (result.kind === "limited") return failure("LIMITED", "The demo has prepared many projects in the last hour. Try again in a few minutes.", 429);
    return retainIdentity(NextResponse.json({ ...await state(result.session, result.visitorId), reused: result.reused }, { status: result.kind === "ready" ? 200 : 202, headers }), req, result.session, result.visitorId);
  } catch (error) {
    if (error instanceof SandboxGuardError) return failure("PAYPAL_NOT_CONFIGURED", "PayPal Sandbox is not configured on this server.", 503);
    return failure("STORAGE_UNAVAILABLE", "The saved run could not be read or advanced. Reload to check the same run before retrying.", 503);
  }
}
