import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalStoreError } from "./store";
import { getApprovalResponse, postApprovalResponse } from "./http";

const mock = vi.hoisted(() => ({ getWorkspace: vi.fn(), decide: vi.fn() }));
vi.mock("./server", () => ({ approvalStore: () => mock }));

const orderId = randomUUID();
const sessionId = randomUUID();
const origin = "http://localhost:3002";
const path = `/api/change-orders/${orderId}/approval`;

function input() {
  return {
    decision: "approved", contentHash: "a".repeat(64), revisionContentHash: "b".repeat(64),
    acknowledged: true, signature: "Avery Chen", note: "",
  };
}

function request(options: {
  method?: "GET" | "POST";
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  omitOrigin?: boolean;
  omitContentType?: boolean;
} = {}) {
  const method = options.method ?? "GET";
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: {
      ...(method === "POST" && !options.omitOrigin ? { Origin: origin } : {}),
      ...(method === "POST" && !options.omitContentType ? { "Content-Type": "application/json" } : {}),
      ...(options.cookie ? { Cookie: `setti-demo-chat=${options.cookie}` } : {}),
      ...options.headers,
    },
    ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("client approval HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getWorkspace.mockResolvedValue({
      view: { order: { id: orderId, version: 3 }, status: "awaiting_client_confirmation" },
      canDecide: false, clientName: null, reason: "Read-only share link.", fundingPlan: null,
    });
    mock.decide.mockResolvedValue({
      view: { order: { id: orderId, version: 3 }, status: "approved" },
      canDecide: false, clientName: "Avery Chen", reason: "Decision recorded.", fundingPlan: { executable: false },
    });
  });

  it("allows public reads without creating a session or granting a confirmation cookie", async () => {
    const response = await getApprovalResponse(request(), orderId);
    expect(response.status).toBe(200);
    expect(mock.getWorkspace).toHaveBeenCalledWith(null, orderId);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toMatchObject({ canDecide: false, clientName: null, fundingPlan: null });
  });

  it("passes the existing owner cookie through without replacing it", async () => {
    const response = await getApprovalResponse(request({ cookie: sessionId }), orderId);
    expect(response.status).toBe(200);
    expect(mock.getWorkspace).toHaveBeenCalledWith(sessionId, orderId);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("treats malformed cookies as anonymous public reads", async () => {
    const response = await getApprovalResponse(request({ cookie: "not-a-session" }), orderId);
    expect(response.status).toBe(200);
    expect(mock.getWorkspace).toHaveBeenCalledWith(null, orderId);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects invalid order IDs before reading or writing storage", async () => {
    expect((await getApprovalResponse(request(), "not-an-id")).status).toBe(404);
    expect((await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: input() }), "not-an-id")).status).toBe(404);
    expect(mock.getWorkspace).not.toHaveBeenCalled();
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("returns not found for a missing public document", async () => {
    mock.getWorkspace.mockResolvedValueOnce(null);
    const response = await getApprovalResponse(request(), orderId);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([undefined, "not-a-session"])("rejects confirmation without an existing valid session: %s", async (cookie) => {
    const response = await postApprovalResponse(request({ method: "POST", cookie, body: input() }), orderId);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("requires the exact same origin for writes, including an Origin header", async () => {
    const requests = [
      request({ method: "POST", cookie: sessionId, body: input(), headers: { Origin: "https://other.example" } }),
      request({ method: "POST", cookie: sessionId, body: input(), headers: { Origin: "https://localhost:3002" } }),
      request({ method: "POST", cookie: sessionId, body: input(), omitOrigin: true }),
    ];
    for (const req of requests) {
      const response = await postApprovalResponse(req, orderId);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("requires JSON content type before storage is touched", async () => {
    const requests = [
      request({ method: "POST", cookie: sessionId, body: input(), headers: { "Content-Type": "text/plain" } }),
      request({ method: "POST", cookie: sessionId, body: input(), omitContentType: true }),
    ];
    for (const req of requests) expect((await postApprovalResponse(req, orderId)).status).toBe(415);
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("bounds streamed UTF-8 bytes even without a content-length header", async () => {
    const req = request({ method: "POST", cookie: sessionId, body: { ...input(), note: "椅".repeat(6000) } });
    expect(req.headers.get("content-length")).toBeNull();
    const response = await postApprovalResponse(req, orderId);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("rejects absent bodies and malformed JSON without leaking parser details", async () => {
    for (const req of [
      request({ method: "POST", cookie: sessionId }),
      request({ method: "POST", cookie: sessionId, rawBody: "{broken-json" }),
    ]) {
      const response = await postApprovalResponse(req, orderId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it.each([
    { acknowledged: false },
    { acknowledged: undefined },
    { contentHash: "forged" },
    { revisionContentHash: "B".repeat(64) },
    { signature: "   " },
    { signature: "x".repeat(161) },
    { signature: 123 },
    { note: "x".repeat(3001) },
    { decision: "pay_now" },
    { totalCents: 1 },
    { actor: "client" },
    { approved: true },
  ])("rejects invalid acknowledgment, identity, hashes and injected fields: %j", async (patch) => {
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: { ...input(), ...patch } }), orderId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(mock.decide).not.toHaveBeenCalled();
  });

  it("passes validated decisions and trimmed names through with the owner session and frozen hashes", async () => {
    const body = { ...input(), signature: "  Avery Chen  ", note: "  Please proceed.  " };
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body }), orderId);
    expect(response.status).toBe(200);
    expect(mock.decide).toHaveBeenCalledWith(sessionId, orderId, { ...input(), signature: "Avery Chen", note: "Please proceed." });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(await response.json()).toMatchObject({ view: { status: "approved" }, fundingPlan: { executable: false } });
  });

  it("passes a request for changes to storage instead of treating it as approval", async () => {
    const body = { ...input(), decision: "changes_requested", note: "Please check the finish." };
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body }), orderId);
    expect(response.status).toBe(200);
    expect(mock.decide).toHaveBeenCalledWith(sessionId, orderId, body);
  });

  it("returns a store-rejected signed name as a client error", async () => {
    mock.decide.mockRejectedValueOnce(new ApprovalStoreError("INVALID_INPUT", "Type the exact demo client name."));
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: { ...input(), signature: "Another person" } }), orderId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT", error: "Type the exact demo client name." });
  });

  it.each(["CONTENT_CHANGED", "DECISION_CONFLICT", "CASE_BUSY", "STALE_VERSION"])("returns actionable version conflicts: %s", async (code) => {
    mock.decide.mockRejectedValueOnce(new ApprovalStoreError(code, "Reload the current saved version."));
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: input() }), orderId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code, error: "Reload the current saved version." });
  });

  it.each([
    { code: "FORBIDDEN", status: 403 },
    { code: "NOT_FOUND", status: 404 },
  ])("preserves managed store errors: $code", async ({ code, status }) => {
    mock.decide.mockRejectedValueOnce(new ApprovalStoreError(code, "The document is unavailable to this session."));
    const response = await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: input() }), orderId);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  it("sanitizes unexpected GET and POST storage failures as unavailable", async () => {
    const secretError = new Error("postgres password=private-value SELECT private_client_data");
    mock.getWorkspace.mockRejectedValueOnce(secretError);
    mock.decide.mockRejectedValueOnce(secretError);
    for (const response of [
      await getApprovalResponse(request(), orderId),
      await postApprovalResponse(request({ method: "POST", cookie: sessionId, body: input() }), orderId),
    ]) {
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.code).toBe("STORAGE_UNAVAILABLE");
      expect(JSON.stringify(body)).not.toMatch(/postgres|password|private-value|SELECT|private_client_data/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});

