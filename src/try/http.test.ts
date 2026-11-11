import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/http/identity";
import { clientActor, designerActor } from "@/http/testing";
import { getTryResponse, postDemoPersonaResponse, postTryResponse } from "./http";

const mock = vi.hoisted(() => ({
  startTry: vi.fn(), readTrySeed: vi.fn(), readTryRuns: vi.fn(), prepareTry: vi.fn(), resumeTry: vi.fn(), openWillowWorkspace: vi.fn(),
  sandboxPayPal: vi.fn(() => ({})), sandboxTestCard: vi.fn(() => async () => ({ kind: "ok", value: {} })),
  createDb: vi.fn(() => ({ db: {}, pool: {} })),
}));
/** Who is signed in, and the demo's people: kept apart from `mock`, whose calls the tests count as storage or provider work. */
const auth = vi.hoisted(() => ({
  requestActor: vi.fn(), ensureDemoPeople: vi.fn(), findDemoPerson: vi.fn(), signInDemoPerson: vi.fn(), signOut: vi.fn(),
}));
vi.mock("./service", () => ({
  MAPLE_SCENARIO: "maple-mixed-change-v1", TRY_PROJECT_HREF: "/chats/maple",
  startTry: mock.startTry, readTrySeed: mock.readTrySeed, readTryRuns: mock.readTryRuns,
  prepareTry: mock.prepareTry, resumeTry: mock.resumeTry, openWillowWorkspace: mock.openWillowWorkspace,
}));
vi.mock("@/payments/server", () => ({ sandboxPayPal: mock.sandboxPayPal, sandboxTestCard: mock.sandboxTestCard }));
vi.mock("@/db/client", () => ({ createDb: mock.createDb }));
vi.mock("@/http/actor", () => ({ requestActor: auth.requestActor }));
vi.mock("./people", () => ({ ensureDemoPeople: auth.ensureDemoPeople, findDemoPerson: auth.findDemoPerson, signInDemoPerson: auth.signInDemoPerson }));
vi.mock("@/auth/app", () => ({ appAuth: () => ({ api: { signOut: auth.signOut } }) }));

const origin = "http://localhost:3002";
const SESSION_COOKIE = "setti.session_token";
const visitor = randomUUID(), session = randomUUID(), oldRun = randomUUID(), orderId = randomUUID();
const seed = {
  runId: session, scenario: "maple-living-dining-v3", scenarioVersion: 3, status: "seeding", stage: "chair_hold",
  stages: [{ id: "quote", label: "Confirm quote", status: "done", operationIds: [] }, { id: "chair_hold", label: "Hold chair", status: "pending", operationIds: [] }],
  busy: false, canResume: true, changeOrderId: orderId, error: null,
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
};
/** The demo's people of the run `session`. */
const jordan = designerActor(session, { persona: "jordan" });
const emma = clientActor(session, ["maple"], { persona: "emma" });
const people = {
  jordan: { persona: "jordan", userId: jordan.userId, email: "jordan.run@demo.setti.invalid" },
  emma: { persona: "emma", userId: emma.userId, email: "emma.run@demo.setti.invalid" },
};
const signedIn = (token: string) => new Response(null, { headers: { "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` } });

function post(body?: unknown, options: { origin?: string; actor?: Actor | null; visitor?: string } = {}) {
  auth.requestActor.mockResolvedValue(options.actor ?? null);
  return new NextRequest(origin + "/api/try", {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: options.origin ?? origin, Cookie: options.visitor ? "setti-try-visitor=" + options.visitor : "" },
  });
}
describe("/try HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.unstubAllEnvs();
    mock.createDb.mockReset().mockReturnValue({ db: {}, pool: {} });
    delete (globalThis as typeof globalThis & { settiChatDatabase?: unknown }).settiChatDatabase;
    mock.startTry.mockResolvedValue({ kind: "started", session, visitorId: visitor, seed, reused: false });
    mock.readTrySeed.mockResolvedValue(seed);
    mock.readTryRuns.mockResolvedValue([]);
    mock.prepareTry.mockResolvedValue({ kind: "progress", seed });
    mock.resumeTry.mockResolvedValue(seed);
    mock.openWillowWorkspace.mockResolvedValue(session);
    auth.requestActor.mockResolvedValue(null);
    auth.ensureDemoPeople.mockResolvedValue(people);
    auth.findDemoPerson.mockImplementation(async (_db: unknown, _run: string, persona: "jordan" | "emma") => people[persona]);
    auth.signInDemoPerson.mockImplementation(async (_db: unknown, _auth: unknown, person: { persona: string }) => signedIn(`as-${person.persona}`));
    auth.signOut.mockResolvedValue(new Response(null, { headers: { "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/` } }));
  });

  it.each(["http:", "https:"])("ends a demo over %s: records the end, signs the demo person out and expires the browser's demo cookies", async (protocol) => {
    auth.requestActor.mockResolvedValue(jordan);
    const req = new NextRequest(protocol + "//localhost:3002/api/try", {
      method: "POST", body: JSON.stringify({ action: "end" }),
      headers: { Origin: protocol + "//localhost:3002", "Content-Type": "application/json",
        Cookie: "setti-demo-chat=" + session + "; setti-try-visitor=" + visitor + "; setti-demo-account=emma" },
    });
    const response = await postTryResponse(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true, href: "/try" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
    // The visitor id, and the cookies older demos kept, expire too.
    for (const name of ["setti-demo-chat", "setti-try-visitor", "setti-demo-account"]) {
      expect(response.cookies.get(name)).toMatchObject({ value: "", path: "/", sameSite: "lax", maxAge: 0,
        expires: new Date(0), secure: protocol === "https:", httpOnly: name !== "setti-demo-account" });
      expect(response.cookies.get(name)?.domain).toBeUndefined();
    }
    // Ending records the end in storage; it never starts, resumes or prepares a run.
    for (const fn of [mock.startTry, mock.readTrySeed, mock.readTryRuns, mock.prepareTry, mock.resumeTry, mock.openWillowWorkspace, mock.sandboxTestCard]) expect(fn).not.toHaveBeenCalled();
  });

  it("leaves a real account signed in when its browser ends no demo", async () => {
    const response = await postTryResponse(post({ action: "end" }, { actor: designerActor() }));
    expect(response.status).toBe(200);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("can end an empty browser session even when storage or sign-ins are unavailable", async () => {
    mock.createDb.mockImplementation(() => { throw new Error("Storage unavailable"); });
    auth.requestActor.mockRejectedValue(new Error("Storage unavailable"));
    const req = new NextRequest(origin + "/api/try", { method: "POST", body: JSON.stringify({ action: "end" }), headers: { Origin: origin, "Content-Type": "application/json" } });
    const response = await postTryResponse(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true, href: "/try" });
    expect(response.cookies.getAll().map((cookie) => cookie.name)).toEqual(["setti-try-visitor"]);
    for (const fn of Object.values(mock)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects foreign, null and missing Origins before ending a demo", async () => {
    for (const requestOrigin of ["https://attacker.example", "null", null]) {
      const req = post({ action: "end" }, { actor: jordan, visitor });
      if (requestOrigin === null) req.headers.delete("origin"); else req.headers.set("origin", requestOrigin);
      const response = await postTryResponse(req);
      expect(response.status).toBe(403);
      expect(response.cookies.getAll()).toHaveLength(0);
    }
    for (const fn of [...Object.values(mock), auth.signOut]) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects extra fields on an end command without expiring any cookie", async () => {
    const response = await postTryResponse(post({ action: "end", runId: session }, { actor: jordan, visitor }));
    expect(response.status).toBe(400);
    expect(response.cookies.getAll()).toHaveLength(0);
    for (const fn of [...Object.values(mock), auth.signOut]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1:3002", "localhost:3002"])("accepts the browser's actual %s Host instead of Next's normalized authority", async (host) => {
    const req = post({ action: "start" }, { origin: "http://" + host });
    req.headers.set("host", host);
    expect((await postTryResponse(req)).status).toBe(202);
    expect(mock.startTry).toHaveBeenCalledTimes(1);
  });

  it("requires Origin to match the actual Host before allocating a run", async () => {
    for (const origin of [null, "null", "http://localhost:3002", "https://attacker.example"]) {
      const req = post({ action: "start" });
      req.headers.set("host", "127.0.0.1:3002");
      if (origin === null) req.headers.delete("origin"); else req.headers.set("origin", origin);
      req.headers.set("x-forwarded-host", "attacker.example");
      expect((await postTryResponse(req)).status).toBe(403);
    }
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });

  it("makes the run's people and signs the browser in as its designer before constructing a provider client or preparing money", async () => {
    const response = await postTryResponse(post({ action: "start", scenario: "maple-living-dining-v3" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ seed, href: "/chats/maple", previousRuns: [], hasWorkspace: true, reused: false });
    expect(auth.ensureDemoPeople).toHaveBeenCalledWith({}, expect.anything(), session);
    expect(auth.signInDemoPerson).toHaveBeenCalledWith({}, expect.anything(), people.jordan, undefined);
    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({ value: "as-jordan", httpOnly: true, sameSite: "lax" });
    expect(response.cookies.get("setti-try-visitor")).toMatchObject({ value: visitor, httpOnly: true, sameSite: "lax" });
    // The demo's own session is the sign-in; the old session cookie is not set any more.
    expect(response.cookies.get("setti-demo-chat")).toBeUndefined();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    expect(mock.sandboxTestCard).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });

  it("keeps the person a visitor already is when their own run starts again", async () => {
    mock.startTry.mockResolvedValue({ kind: "ready", session, visitorId: visitor, seed, reused: true });
    const response = await postTryResponse(post({}, { actor: emma, visitor }));
    expect(response.status).toBe(200);
    expect(mock.startTry).toHaveBeenCalledWith(expect.anything(), session, expect.anything());
    expect(auth.signInDemoPerson).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("starts only the current walkthrough; retired scenarios with scripted AI exchanges cannot start", async () => {
    for (const retired of ["maple-mixed-change-v1", "maple-living-dining-v2", "maple-living-dining-v4"]) {
      expect((await postTryResponse(post({ action: "start", scenario: retired }))).status).toBe(400);
    }
    expect(mock.startTry).not.toHaveBeenCalled();
    await postTryResponse(post());
    expect(mock.startTry).toHaveBeenLastCalledWith(expect.anything(), null, expect.objectContaining({ scenario: "maple-living-dining-v3" }));
    expect((await postTryResponse(post({ action: "start", scenario: "maple-living-dining-v3" }))).status).toBe(202);
    expect(mock.startTry).toHaveBeenLastCalledWith(expect.anything(), null, expect.objectContaining({ scenario: "maple-living-dining-v3" }));
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });

  it("does not prepare a saved run of a retired walkthrough", async () => {
    mock.readTrySeed.mockResolvedValue({ ...seed, scenario: "maple-mixed-change-v1", scenarioVersion: 1 });
    const response = await postTryResponse(post({ action: "prepare", runId: session }, { actor: jordan, visitor }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "RETIRED" });
    expect(mock.prepareTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
  });

  it("GET only reads truthful saved progress, including previous runs, and never starts preparation", async () => {
    const previous = [{ runId: oldRun, status: "ready", createdAt: seed.createdAt }];
    mock.readTryRuns.mockResolvedValue(previous);
    auth.requestActor.mockResolvedValue(emma);
    const response = await getTryResponse(new NextRequest(origin + "/api/try", { headers: { Cookie: "setti-try-visitor=" + visitor } }));
    expect(await response.json()).toMatchObject({ seed, previousRuns: previous, hasWorkspace: true });
    expect(mock.readTrySeed).toHaveBeenCalledWith({}, session);
    expect(mock.readTryRuns).toHaveBeenCalledWith({}, visitor, session);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    mock.readTrySeed.mockResolvedValue(null); mock.readTryRuns.mockResolvedValue([]);
    for (const actor of [null, designerActor()]) {
      auth.requestActor.mockResolvedValue(actor);
      expect(await (await getTryResponse(new NextRequest(origin + "/api/try"))).json()).toMatchObject({ seed: null, hasWorkspace: false });
      expect(mock.readTrySeed).toHaveBeenLastCalledWith({}, null);
    }
  });

  it("keeps an empty POST compatible with allocation and rejects unsupported or cross-site commands", async () => {
    expect((await postTryResponse(post())).status).toBe(202);
    for (const body of [{ action: "prepare" }, { action: "start", scenario: "other" }, { restart: "yes" }, { amountCents: 1 }, { action: "workspace", scenario: "maple-mixed-change-v1" }]) {
      expect((await postTryResponse(post(body))).status).toBe(400);
    }
    expect((await postTryResponse(post({}, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect(mock.startTry).toHaveBeenCalledTimes(1);
  });

  it("advances only the run of the signed-in demo person", async () => {
    expect((await postTryResponse(post({ action: "prepare", runId: session }))).status).toBe(403);
    expect((await postTryResponse(post({ action: "prepare", runId: session }, { actor: designerActor(oldRun, { persona: "jordan" }) }))).status).toBe(403);
    expect((await postTryResponse(post({ action: "prepare", runId: session }, { actor: designerActor(session) }))).status).toBe(403);
    expect(mock.prepareTry).not.toHaveBeenCalled();
    const response = await postTryResponse(post({ action: "prepare", runId: session }, { actor: emma, visitor }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ seed, href: "/chats/maple" });
    expect(mock.prepareTry).toHaveBeenCalledWith(expect.objectContaining({ perHour: 30 }), session, session);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it.each([["progress", 202], ["busy", 202], ["ready", 200], ["failed", 502]] as const)("returns full saved state for %s preparation", async (kind, status) => {
    const current = { ...seed, status: kind === "ready" ? "ready" : kind === "failed" ? "failed" : "seeding", busy: kind === "busy", error: kind === "failed" ? "Resume the original saved operation." : null };
    mock.prepareTry.mockResolvedValue({ kind, seed: current });
    mock.readTrySeed.mockResolvedValue(current);
    const response = await postTryResponse(post({ action: "prepare", runId: session }, { actor: jordan, visitor }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ seed: current, href: "/chats/maple", previousRuns: [], hasWorkspace: true });
  });

  it("resumes only an old run belonging to the stable visitor and signs in as its designer", async () => {
    mock.resumeTry.mockResolvedValue({ ...seed, runId: oldRun });
    const response = await postTryResponse(post({ action: "resume", runId: oldRun }, { actor: jordan, visitor }));
    expect(response.status).toBe(200);
    expect(mock.resumeTry).toHaveBeenCalledWith({}, visitor, oldRun);
    expect(auth.ensureDemoPeople).toHaveBeenCalledWith({}, expect.anything(), oldRun);
    // The old run's designer replaces the current run's person, whose session ends.
    expect(auth.signInDemoPerson).toHaveBeenCalledWith({}, expect.anything(), people.jordan, jordan.authSessionId);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("as-jordan");
    expect(mock.prepareTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    mock.resumeTry.mockResolvedValue(null);
    auth.signInDemoPerson.mockClear();
    const denied = await postTryResponse(post({ action: "resume", runId: oldRun }, { actor: jordan, visitor: randomUUID() }));
    expect(denied.status).toBe(404);
    expect(auth.signInDemoPerson).not.toHaveBeenCalled();
    expect(denied.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("opens Willow in the visitor's own run, and only once a demo is running", async () => {
    const response = await postTryResponse(post({ action: "workspace", scenario: "willow-first-payment-v1" }, { actor: jordan, visitor }));
    expect(mock.openWillowWorkspace).toHaveBeenCalledWith({}, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ seed, href: "/quotes/willow", hasWorkspace: true, reused: true });
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    mock.openWillowWorkspace.mockClear();
    expect((await postTryResponse(post({ action: "workspace", scenario: "willow-first-payment-v1" }))).status).toBe(403);
    expect(mock.openWillowWorkspace).not.toHaveBeenCalled();
  });

  it("keeps rate limiting atomic in the service and signs no one in when allocation is limited", async () => {
    vi.stubEnv("SETTI_TRY_PER_HOUR", "5");
    await postTryResponse(post());
    vi.stubEnv("SETTI_TRY_PER_HOUR", "lots");
    await postTryResponse(post());
    expect(mock.startTry.mock.calls.map(([deps]) => deps.perHour)).toEqual([5, 30]);
    mock.startTry.mockResolvedValue({ kind: "limited" });
    auth.signInDemoPerson.mockClear();
    const response = await postTryResponse(post({ restart: true }, { actor: jordan, visitor }));
    expect(response.status).toBe(429);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(auth.signInDemoPerson).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });
});

describe("switching between the demo's people", () => {
  const request = (body: unknown, actor: Actor | null, from = origin) => {
    auth.requestActor.mockResolvedValue(actor);
    return new NextRequest(origin + "/api/demo/persona", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: from } });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    auth.findDemoPerson.mockImplementation(async (_db: unknown, _run: string, persona: "jordan" | "emma") => people[persona]);
    auth.signInDemoPerson.mockImplementation(async (_db: unknown, _auth: unknown, person: { persona: string }) => signedIn(`as-${person.persona}`));
  });

  it("signs the browser in as the run's other person, ending the current session, and says where to go", async () => {
    const response = await postDemoPersonaResponse(request({ persona: "emma", next: "/inbox" }, jordan));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "/inbox" });
    expect(auth.findDemoPerson).toHaveBeenCalledWith({}, session, "emma");
    expect(auth.signInDemoPerson).toHaveBeenCalledWith({}, expect.anything(), people.emma, jordan.authSessionId);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("as-emma");
  });

  it("stays on this site, whatever page it is asked to go to next", async () => {
    for (const next of ["https://evil.example/", "//evil.example", undefined]) {
      expect(await (await postDemoPersonaResponse(request({ persona: "jordan", ...(next ? { next } : {}) }, emma))).json()).toEqual({ next: "/chats/maple" });
    }
  });

  it("changes nothing when the visitor already is that person", async () => {
    const response = await postDemoPersonaResponse(request({ persona: "jordan", next: "/money" }, jordan));
    expect(await response.json()).toEqual({ next: "/money" });
    expect(auth.signInDemoPerson).not.toHaveBeenCalled();
  });

  it("is only for a signed-in demo visitor, from this app's pages, between Jordan and Emma", async () => {
    expect((await postDemoPersonaResponse(request({ persona: "emma" }, null))).status).toBe(401);
    expect((await postDemoPersonaResponse(request({ persona: "emma" }, designerActor()))).status).toBe(403);
    expect((await postDemoPersonaResponse(request({ persona: "emma" }, jordan, "https://evil.example"))).status).toBe(403);
    for (const body of [{ persona: "sofia" }, { persona: "emma", userId: emma.userId }, {}]) expect((await postDemoPersonaResponse(request(body, jordan))).status).toBe(400);
    auth.findDemoPerson.mockResolvedValueOnce(null);
    expect((await postDemoPersonaResponse(request({ persona: "emma" }, jordan))).status).toBe(404);
    expect(auth.signInDemoPerson).not.toHaveBeenCalled();
  });
});
