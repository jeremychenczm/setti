import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTryResponse, postTryResponse } from "./http";

const mock = vi.hoisted(() => ({
  startTry: vi.fn(), readTrySeed: vi.fn(), readTryRuns: vi.fn(), prepareTry: vi.fn(), resumeTry: vi.fn(), openWillowWorkspace: vi.fn(),
  sandboxPayPal: vi.fn(() => ({})), sandboxTestCard: vi.fn(() => async () => ({ kind: "ok", value: {} })),
  createDb: vi.fn(() => ({ db: {}, pool: {} })),
}));
vi.mock("./service", () => ({
  MAPLE_SCENARIO: "maple-mixed-change-v1", TRY_PROJECT_HREF: "/chats/maple",
  startTry: mock.startTry, readTrySeed: mock.readTrySeed, readTryRuns: mock.readTryRuns,
  prepareTry: mock.prepareTry, resumeTry: mock.resumeTry, openWillowWorkspace: mock.openWillowWorkspace,
}));
vi.mock("@/payments/server", () => ({ sandboxPayPal: mock.sandboxPayPal, sandboxTestCard: mock.sandboxTestCard }));
vi.mock("@/db/client", () => ({ createDb: mock.createDb }));
const origin = "http://localhost:3002";
const visitor = randomUUID(), session = randomUUID(), oldRun = randomUUID(), orderId = randomUUID();
const seed = {
  runId: session, scenario: "maple-mixed-change-v1", scenarioVersion: 1, status: "seeding", stage: "chair_hold",
  stages: [{ id: "quote", label: "Confirm quote", status: "done", operationIds: [] }, { id: "chair_hold", label: "Hold chair", status: "pending", operationIds: [] }],
  busy: false, canResume: true, changeOrderId: orderId, error: null,
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
};
function post(body?: unknown, options: { origin?: string; session?: string; visitor?: string } = {}) {
  return new NextRequest(origin + "/api/try", {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: options.origin ?? origin,
      Cookie: [options.session && "setti-demo-chat=" + options.session, options.visitor && "setti-try-visitor=" + options.visitor].filter(Boolean).join("; ") },
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
  });

  it.each(["http:", "https:"])("ends a demo over %s by expiring only its three browser cookies without storage or payment work", async (protocol) => {
    const req = new NextRequest(protocol + "//localhost:3002/api/try", {
      method: "POST", body: JSON.stringify({ action: "end" }),
      headers: { Origin: protocol + "//localhost:3002", "Content-Type": "application/json",
        Cookie: "setti-demo-chat=" + session + "; setti-try-visitor=" + visitor + "; setti-demo-account=emma" },
    });
    const response = await postTryResponse(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true, href: "/try" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.cookies.getAll()).toHaveLength(3);
    for (const name of ["setti-demo-chat", "setti-try-visitor", "setti-demo-account"]) {
      expect(response.cookies.get(name)).toMatchObject({ value: "", path: "/", sameSite: "lax", maxAge: 0,
        expires: new Date(0), secure: protocol === "https:", httpOnly: name !== "setti-demo-account" });
      expect(response.cookies.get(name)?.domain).toBeUndefined();
    }
    for (const fn of Object.values(mock)) expect(fn).not.toHaveBeenCalled();
  });

  it("can end an empty browser session even when storage is unavailable", async () => {
    mock.createDb.mockImplementation(() => { throw new Error("Storage unavailable"); });
    const response = await postTryResponse(post({ action: "end" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true, href: "/try" });
    expect(response.cookies.getAll()).toHaveLength(3);
    for (const fn of Object.values(mock)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects foreign, null and missing Origins before ending a demo", async () => {
    for (const requestOrigin of ["https://attacker.example", "null", null]) {
      const req = post({ action: "end" }, { session, visitor });
      if (requestOrigin === null) req.headers.delete("origin"); else req.headers.set("origin", requestOrigin);
      const response = await postTryResponse(req);
      expect(response.status).toBe(403);
      expect(response.cookies.getAll()).toHaveLength(0);
    }
    for (const fn of Object.values(mock)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects extra fields on an end command without expiring any cookie", async () => {
    const response = await postTryResponse(post({ action: "end", runId: session }, { session, visitor }));
    expect(response.status).toBe(400);
    expect(response.cookies.getAll()).toHaveLength(0);
    for (const fn of Object.values(mock)) expect(fn).not.toHaveBeenCalled();
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

  it("allocates and sets both private cookies before constructing a provider client or preparing money", async () => {
    const response = await postTryResponse(post({ action: "start", scenario: "maple-mixed-change-v1" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ seed, href: "/chats/maple", previousRuns: [], hasWorkspace: true, reused: false });
    for (const [name, value] of [["setti-demo-chat", session], ["setti-try-visitor", visitor]]) {
      expect(response.cookies.get(name)).toMatchObject({ value, httpOnly: true, sameSite: "lax" });
    }
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    expect(mock.sandboxTestCard).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });

  it("accepts the living-and-dining scenario explicitly without changing the legacy empty command", async () => {
    expect((await postTryResponse(post({ action: "start", scenario: "maple-living-dining-v2" }))).status).toBe(202);
    expect(mock.startTry).toHaveBeenLastCalledWith(expect.anything(), null, expect.objectContaining({ scenario: "maple-living-dining-v2" }));
    await postTryResponse(post());
    expect(mock.startTry.mock.calls[1][2]).not.toHaveProperty("scenario");
    expect((await postTryResponse(post({ action: "start", scenario: "maple-living-dining-v3" }))).status).toBe(202);
    expect(mock.startTry).toHaveBeenLastCalledWith(expect.anything(), null, expect.objectContaining({ scenario: "maple-living-dining-v3" }));
    expect((await postTryResponse(post({ action: "start", scenario: "maple-living-dining-v4" }))).status).toBe(400);
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });

  it("GET only reads truthful saved progress, including previous runs, and never starts preparation", async () => {
    const previous = [{ runId: oldRun, status: "ready", createdAt: seed.createdAt }];
    mock.readTryRuns.mockResolvedValue(previous);
    const response = await getTryResponse(new NextRequest(origin + "/api/try", { headers: { Cookie: "setti-demo-chat=" + session + "; setti-try-visitor=" + visitor } }));
    expect(await response.json()).toMatchObject({ seed, previousRuns: previous, hasWorkspace: true });
    expect(mock.readTrySeed).toHaveBeenCalledWith({}, session);
    expect(mock.readTryRuns).toHaveBeenCalledWith({}, visitor, session);
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    mock.readTrySeed.mockResolvedValue(null); mock.readTryRuns.mockResolvedValue([]);
    expect(await (await getTryResponse(new NextRequest(origin + "/api/try"))).json()).toMatchObject({ seed: null, hasWorkspace: false });
  });

  it("upgrades an old ready visitor's cookie attributes on GET without minting identities or changing the chosen account", async () => {
    const response = await getTryResponse(new NextRequest(origin + "/api/try", { headers: {
      Cookie: "setti-demo-chat=" + session + "; setti-try-visitor=" + visitor + "; setti-demo-account=emma",
    } }));
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ value: session, sameSite: "lax", httpOnly: true });
    expect(response.cookies.get("setti-try-visitor")).toMatchObject({ value: visitor, sameSite: "lax", httpOnly: true });
    expect(response.cookies.get("setti-demo-account")).toMatchObject({ value: "emma", sameSite: "lax" });
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.prepareTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
  });

  it("keeps an empty POST compatible with allocation and rejects unsupported or cross-site commands", async () => {
    expect((await postTryResponse(post())).status).toBe(202);
    for (const body of [{ action: "prepare" }, { action: "start", scenario: "other" }, { restart: "yes" }, { amountCents: 1 }, { action: "workspace", scenario: "maple-mixed-change-v1" }]) {
      expect((await postTryResponse(post(body))).status).toBe(400);
    }
    expect((await postTryResponse(post({}, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect(mock.startTry).toHaveBeenCalledTimes(1);
  });

  it("advances only the run owned by the current session cookie", async () => {
    expect((await postTryResponse(post({ action: "prepare", runId: session }))).status).toBe(403);
    expect((await postTryResponse(post({ action: "prepare", runId: session }, { session: oldRun }))).status).toBe(403);
    expect(mock.prepareTry).not.toHaveBeenCalled();
    const response = await postTryResponse(post({ action: "prepare", runId: session }, { session, visitor }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ seed, href: "/chats/maple" });
    expect(mock.prepareTry).toHaveBeenCalledWith(expect.objectContaining({ perHour: 30 }), session, session);
    expect(response.cookies.get("setti-demo-chat")).toBeUndefined();
  });

  it.each([["progress", 202], ["busy", 202], ["ready", 200], ["failed", 502]] as const)("returns full saved state for %s preparation", async (kind, status) => {
    const current = { ...seed, status: kind === "ready" ? "ready" : kind === "failed" ? "failed" : "seeding", busy: kind === "busy", error: kind === "failed" ? "Resume the original saved operation." : null };
    mock.prepareTry.mockResolvedValue({ kind, seed: current });
    mock.readTrySeed.mockResolvedValue(current);
    const response = await postTryResponse(post({ action: "prepare", runId: session }, { session, visitor }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ seed: current, href: "/chats/maple", previousRuns: [], hasWorkspace: true });
  });

  it("resumes only an old run belonging to the stable visitor and switches back to its session cookie", async () => {
    mock.resumeTry.mockResolvedValue({ ...seed, runId: oldRun });
    const response = await postTryResponse(post({ action: "resume", runId: oldRun }, { session, visitor }));
    expect(response.status).toBe(200);
    expect(mock.resumeTry).toHaveBeenCalledWith({}, visitor, oldRun);
    expect(response.cookies.get("setti-demo-chat")?.value).toBe(oldRun);
    expect(mock.prepareTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
    mock.resumeTry.mockResolvedValue(null);
    const denied = await postTryResponse(post({ action: "resume", runId: oldRun }, { session, visitor: randomUUID() }));
    expect(denied.status).toBe(404);
    expect(denied.cookies.get("setti-demo-chat")).toBeUndefined();
  });

  it("opens Willow through the designer send action while retaining the existing private workspace and Maple seed", async () => {
    const response = await postTryResponse(post({ action: "workspace", scenario: "willow-first-payment-v1" }, { session, visitor }));
    expect(mock.openWillowWorkspace).toHaveBeenCalledWith({}, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ seed, href: "/quotes/willow", hasWorkspace: true, reused: true });
    expect(response.cookies.get("setti-demo-chat")?.value).toBe(session);
    expect(mock.startTry).not.toHaveBeenCalled();
    expect(mock.sandboxPayPal).not.toHaveBeenCalled();
  });

  it("keeps rate limiting atomic in the service and leaves existing cookies untouched when allocation is limited", async () => {
    vi.stubEnv("SETTI_TRY_PER_HOUR", "5");
    await postTryResponse(post());
    vi.stubEnv("SETTI_TRY_PER_HOUR", "lots");
    await postTryResponse(post());
    expect(mock.startTry.mock.calls.map(([deps]) => deps.perHour)).toEqual([5, 30]);
    mock.startTry.mockResolvedValue({ kind: "limited" });
    const response = await postTryResponse(post({ restart: true }, { session, visitor }));
    expect(response.status).toBe(429);
    expect(response.cookies.get("setti-demo-chat")).toBeUndefined();
    expect(mock.prepareTry).not.toHaveBeenCalled();
  });
});
