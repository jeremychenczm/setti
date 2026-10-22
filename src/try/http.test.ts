import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTryResponse, postTryResponse } from "./http";

const mock = vi.hoisted(() => ({ startTry: vi.fn(), readTrySeed: vi.fn() }));
vi.mock("./service", () => ({ startTry: mock.startTry, readTrySeed: mock.readTrySeed }));
vi.mock("@/payments/server", () => ({ sandboxPayPal: () => ({}), sandboxTestCard: () => async () => ({ kind: "ok", value: {} }) }));
vi.mock("@/db/client", () => ({ createDb: () => ({ db: {}, pool: {} }) }));

const origin = "http://localhost:3002";
const visitor = randomUUID(), seeded = randomUUID(), orderId = randomUUID();

function post(body?: unknown, options: { origin?: string; cookie?: string } = {}) {
  return new NextRequest(`${origin}/api/try`, {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: options.origin ?? origin, ...(options.cookie ? { Cookie: `setti-demo-chat=${options.cookie}` } : {}) },
  });
}

describe("/try HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mock.startTry.mockResolvedValue({ kind: "ready", session: seeded, changeOrderId: orderId, reused: false });
  });

  it("seeds from this app's page only and moves the visitor into the seeded session", async () => {
    expect((await postTryResponse(post({}, { origin: "https://elsewhere.example" }))).status).toBe(403);
    expect(mock.startTry).not.toHaveBeenCalled();

    const response = await postTryResponse(post({ restart: true }, { cookie: visitor }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ href: "/chats/maple", changeOrderId: orderId, reused: false });
    expect(response.cookies.get("setti-demo-chat")).toMatchObject({ value: seeded, httpOnly: true, sameSite: "strict" });
    expect(mock.startTry).toHaveBeenCalledWith(expect.objectContaining({ perHour: 30 }), visitor, { restart: true });
  });

  it("accepts an empty body and rejects anything but a restart flag", async () => {
    expect((await postTryResponse(post())).status).toBe(200);
    expect((await postTryResponse(post({ restart: "yes" }))).status).toBe(400);
    expect((await postTryResponse(post({ amountCents: 1 }))).status).toBe(400);
  });

  it("reads the hourly limit from SETTI_TRY_PER_HOUR and ignores a value that is not a whole number", async () => {
    vi.stubEnv("SETTI_TRY_PER_HOUR", "5");
    await postTryResponse(post());
    vi.stubEnv("SETTI_TRY_PER_HOUR", "lots");
    await postTryResponse(post());
    expect(mock.startTry.mock.calls.map(([deps]) => deps.perHour)).toEqual([5, 30]);
  });

  it.each([
    [{ kind: "busy" }, 409, "BUSY"],
    [{ kind: "limited" }, 429, "LIMITED"],
    [{ kind: "failed", message: "Authorize the lounge chair ($800.00): PayPal said no" }, 502, "SEED_FAILED"],
  ])("answers %o without changing the visitor's session", async (result, status, code) => {
    mock.startTry.mockResolvedValue(result);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await postTryResponse(post({}, { cookie: visitor }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(body.error).not.toContain("PayPal said no");
    expect(response.cookies.get("setti-demo-chat")).toBeUndefined();
    quiet.mockRestore();
  });

  it("tells the page whether this visitor already has a seeded project", async () => {
    mock.readTrySeed.mockResolvedValue({ status: "ready", changeOrderId: orderId, createdAt: new Date() });
    const response = await getTryResponse(new NextRequest(`${origin}/api/try`, { headers: { Cookie: `setti-demo-chat=${visitor}` } }));
    expect(await response.json()).toEqual({ seed: { status: "ready", changeOrderId: orderId }, href: "/chats/maple" });
    expect(mock.readTrySeed).toHaveBeenCalledWith({}, visitor);
    mock.readTrySeed.mockResolvedValue(null);
    expect(await (await getTryResponse(new NextRequest(`${origin}/api/try`))).json()).toEqual({ seed: null, href: "/chats/maple" });
  });
});
