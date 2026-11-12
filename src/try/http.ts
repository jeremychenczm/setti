/**
 * /api/try starts, resumes, prepares and ends a visitor's demo, and
 * /api/demo/persona switches the visitor between the demo's people. A demo run
 * is a demo studio with its own two accounts; the visitor's browser is signed in
 * as one of them, so every other route reads the demo as it reads a real studio.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEMO_VISITOR_COOKIE as VISITOR_COOKIE, RETIRED_DEMO_COOKIES, privateDemoCookieOptions } from "@/accounts/cookie-policy";
import { appAuth } from "@/auth/app";
import { SandboxGuardError } from "@/config/paypalEnv";
import { appDb } from "@/db/shared";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { requestActor } from "@/http/actor";
import { noteRequest, refuseIfEnded } from "@/http/demo-activity";
import { demoRunOf, type Actor } from "@/http/identity";
import { safeNextPath } from "@/http/next-path";
import { isSameOriginRequest } from "@/http/origin";
import { paypalLinks } from "@/payments/http";
import { sandboxPayPal, sandboxTestCard } from "@/payments/server";
import { demoEnd, endDemo, markDemoEnded } from "./activity";
import { ensureDemoPeople, findDemoPerson, signInDemoPerson } from "./people";
import { TRY_PROJECT_HREF, prepareTry, readTryRuns, readTrySeed, resumeTry, startTry } from "./service";

const uuid = z.uuid();
const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
// Only the current walkthrough starts. Retired scenarios wrote scripted agent exchanges, so they stay out of the product.
const startSchema = z.union([
  z.strictObject({ action: z.literal("start").optional(), scenario: z.literal(HOME_SCENARIO).optional(), restart: z.boolean().optional() }),
  z.strictObject({ action: z.literal("prepare"), runId: uuid }),
  z.strictObject({ action: z.literal("resume"), runId: uuid }),
  z.strictObject({ action: z.literal("end") }),
]);
const personaSchema = z.strictObject({ persona: z.enum(["jordan", "emma"]), next: z.string().max(2_000).optional() });
const db = appDb;

/** The browser's saved visitor id: it lists the runs this browser started, so one can be resumed. It grants nothing else. */
function visitorOf(req: NextRequest): string | null {
  const parsed = uuid.safeParse(req.cookies.get(VISITOR_COOKIE)?.value);
  return parsed.success ? parsed.data : null;
}
function perHour(): number {
  const raw = process.env.SETTI_TRY_PER_HOUR?.trim(), value = raw ? Number(raw) : 30;
  return Number.isInteger(value) && value >= 0 ? value : 30;
}
const failure = (code: string, error: string, status: number) => NextResponse.json({ code, error }, { status, headers });

/**
 * Passes the sign-in's session cookie on to the browser. The cookies go through
 * `response.cookies`, which rewrites the whole Set-Cookie header on each change,
 * so a raw header appended beside it could be dropped. Parsing loses an empty
 * value and `Max-Age=0`, so a cookie emptied by sign-out is set to expire now.
 */
function withCookies(response: NextResponse, from: Response): NextResponse {
  for (const cookie of new NextResponse(null, { headers: from.headers }).cookies.getAll()) {
    response.cookies.set(cookie.value ? cookie : { ...cookie, value: "", maxAge: 0, expires: new Date(0) });
  }
  return response;
}

/** Signs the browser in as the run's designer, unless it already is one of the run's people. */
async function enterRun(response: NextResponse, req: NextRequest, actor: Actor | null, runId: string, visitorId: string): Promise<NextResponse> {
  response.cookies.set(VISITOR_COOKIE, visitorId, privateDemoCookieOptions(req.nextUrl.protocol));
  const auth = appAuth();
  const people = await ensureDemoPeople(db(), auth, runId);
  if (actor && demoRunOf(actor) === runId) return response;
  return withCookies(response, await signInDemoPerson(db(), auth, people.jordan, actor?.authSessionId));
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
  try {
    const actor = await requestActor(req);
    const current = actor ? demoRunOf(actor) : null;
    noteRequest(current);
    // A real account would be signed out by starting the demo, so /try asks first.
    const signedInAs = actor && !actor.demoPersona ? actor.name : null;
    return NextResponse.json({ ...await state(current, visitorOf(req)), signedInAs }, { headers });
  } catch { return failure("STORAGE_UNAVAILABLE", "Demo storage is unavailable. Make sure the database is running and migrated.", 503); }
}

export async function postTryResponse(req: NextRequest) {
  if (!isSameOriginRequest(req)) return failure("FORBIDDEN", "Start the demo from this app's /try page.", 403);
  const text = await req.text();
  if (text.length > 1_024) return failure("INVALID_REQUEST", "The request is too large.", 413);
  let body: z.infer<typeof startSchema>;
  try { body = startSchema.parse(text ? JSON.parse(text) : {}); }
  catch { return failure("INVALID_REQUEST", "Choose a supported demo action and scenario.", 400); }
  try {
    // Ending must work even when sign-ins cannot be read: it still clears this browser's cookies.
    const actor = body.action === "end" ? await requestActor(req).catch(() => null) : await requestActor(req);
    const current = actor ? demoRunOf(actor) : null, visitorId = visitorOf(req);
    noteRequest(current);
    if (body.action === "end") {
      if (current) await endOnReset(current);
      const response = NextResponse.json({ reset: true, href: "/" }, { headers });
      // Signing out ends the demo person's session; a real account's session is left alone.
      if (current) withCookies(response, await appAuth().api.signOut({ headers: req.headers, asResponse: true }));
      const options = { ...privateDemoCookieOptions(req.nextUrl.protocol), maxAge: 0, expires: new Date(0) };
      response.cookies.set(VISITOR_COOKIE, "", options);
      for (const { name, httpOnly } of RETIRED_DEMO_COOKIES) if (req.cookies.has(name)) response.cookies.set(name, "", { ...options, httpOnly });
      return response;
    }
    if (body.action === "resume") {
      const seed = await resumeTry(db(), visitorId, body.runId);
      if (!seed || !visitorId) return failure("NOT_FOUND", "This run does not belong to this browser's saved visitor.", 404);
      return await enterRun(NextResponse.json({ ...await state(seed.runId, visitorId), reused: true }, { headers }), req, actor, seed.runId, visitorId);
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
    const response = NextResponse.json({ ...await state(result.session, result.visitorId), reused: result.reused }, { status: result.kind === "ready" ? 200 : 202, headers });
    return await enterRun(response, req, actor, result.session, result.visitorId);
  } catch (error) {
    if (error instanceof SandboxGuardError) return failure("PAYPAL_NOT_CONFIGURED", "PayPal Sandbox is not configured on this server.", 503);
    return failure("STORAGE_UNAVAILABLE", "The saved run could not be read or advanced. Reload to check the same run before retrying.", 503);
  }
}

/** A demo visitor becomes the demo's other person: the browser is signed in as them. */
export async function postDemoPersonaResponse(req: NextRequest) {
  if (!isSameOriginRequest(req)) return failure("FORBIDDEN", "Switch people from this app's pages.", 403);
  const text = await req.text();
  if (text.length > 4_096) return failure("INVALID_REQUEST", "The request is too large.", 413);
  let body: z.infer<typeof personaSchema>;
  try { body = personaSchema.parse(JSON.parse(text)); }
  catch { return failure("INVALID_REQUEST", "Choose Jordan or Emma.", 400); }
  try {
    const actor = await requestActor(req);
    if (!actor) return failure("SIGN_IN_REQUIRED", "Start the demo from /try first.", 401);
    const run = demoRunOf(actor);
    if (!run) return failure("FORBIDDEN", "Only a demo visitor switches between the demo's people.", 403);
    noteRequest(run);
    const next = safeNextPath(body.next) ?? TRY_PROJECT_HREF;
    if (actor.demoPersona === body.persona) return NextResponse.json({ next }, { headers });
    const person = await findDemoPerson(db(), run, body.persona);
    if (!person) return failure("NOT_FOUND", "This demo has no such person. Start a new demo from /try.", 404);
    return withCookies(NextResponse.json({ next }, { headers }), await signInDemoPerson(db(), appAuth(), person, actor.authSessionId));
  } catch {
    return failure("STORAGE_UNAVAILABLE", "The demo could not switch people right now. Try again shortly.", 503);
  }
}
