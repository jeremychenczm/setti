import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore, StoredCase } from "./types";
import { caseQuote } from "./cases";

const mocks = vi.hoisted(() => ({ store: {} as ChatStore, run: vi.fn(), configured: vi.fn(() => false) }));
vi.mock("./server", () => ({ chatStore: () => mocks.store }));
vi.mock("./service", () => ({ runCaseAi: mocks.run, CaseAiError: class CaseAiError extends Error {} }));
vi.mock("@/ai/model", () => ({ aiConfigured: mocks.configured }));
import { getCaseResponse, postCaseResponse } from "./http";

let state: StoredCase;
beforeEach(() => {
  vi.clearAllMocks();
  state = { id: randomUUID(), projectKey: "willow", messages: [], draft: null, activeMessageId: null };
  mocks.store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state),
    beginAi: vi.fn(), completeAi: vi.fn(), failAi: vi.fn(),
  };
  mocks.run.mockResolvedValue(state);
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3002/api/chat/willow", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
}

describe("case chat HTTP boundary", () => {
  it("sets an opaque HttpOnly cookie and supplies a server-owned demo quote", async () => {
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow"), "willow");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=strict");
    const body = await response.json();
    expect(body.quote.projectId).toBe("willow");
    expect(body.quote.lines).toHaveLength(28);
    expect(body.aiConfigured).toBe(false);
  });
  it("retains the session cookie across reloads", async () => {
    const session = randomUUID();
    await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: { cookie: `setti-demo-chat=${session}` } }), "willow");
    expect(mocks.store.getCase).toHaveBeenCalledWith(session, "willow");
  });
  it("returns the session store's latest confirmed quote rather than the static demo V1", async () => {
    const approved = structuredClone(caseQuote("willow"));
    approved.id = "approved-willow-v3";
    approved.version = 3;
    state.quote = approved;
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow"), "willow");
    const body = await response.json();
    expect(body.quote).toEqual(approved);
    expect(body.quote.id).not.toBe(caseQuote("willow").id);
  });
  it("saves ordinary discussion and links without invoking AI", async () => {
    const input = { id: randomUUID(), actor: "client", text: "这把椅子怎么样 https://shop.example/chair" };
    const response = await postCaseResponse(post(input), "willow");
    expect(response.status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledWith(expect.any(String), "willow", input);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("accepts natural mention requests and retries without appending another message", async () => {
    const id = randomUUID();
    await postCaseResponse(post({ id, actor: "designer", text: "@AI，改成这个，4把。" }), "willow");
    expect(mocks.run).toHaveBeenCalledWith(mocks.store, expect.any(String), "willow", id);
    vi.mocked(mocks.store.appendMessage).mockClear();
    await postCaseResponse(post({ messageId: id }), "willow", true);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("rejects other origins, unknown cases and client-supplied approval or prices", async () => {
    const input = { id: randomUUID(), actor: "client", text: "@AI change" };
    expect((await postCaseResponse(post(input, { origin: "https://another.example" }), "willow")).status).toBe(403);
    expect((await postCaseResponse(post(input), "not-a-case")).status).toBe(404);
    expect((await postCaseResponse(post({ ...input, approved: true, quote: { unitPriceCents: 1 } }), "willow")).status).toBe(400);
    expect((await postCaseResponse(post({ ...input, actor: "assistant" }), "willow")).status).toBe(400);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("limits a chosen demo account to its own projects and role", async () => {
    const asSofia = { cookie: "setti-demo-account=sofia" };
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/maple", { headers: asSofia }), "maple")).status).toBe(403);
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: asSofia }), "willow")).status).toBe(200);
    const asDesigner = await postCaseResponse(post({ id: randomUUID(), actor: "designer", text: "Hello" }, asSofia), "willow");
    expect(asDesigner.status).toBe(403);
    expect((await asDesigner.json()).error).toContain("Sofia Martinez");
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "Hello" }, asSofia), "willow")).status).toBe(200);
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "Hello" }, { cookie: "setti-demo-account=jordan" }), "willow")).status).toBe(403);
  });
  it("bounds request bodies before touching storage", async () => {
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "x".repeat(33000) }), "willow")).status).toBe(413);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
});
