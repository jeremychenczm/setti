import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore, StoredCase } from "./types";
import { approvedForTest } from "../opening/testing";

const mocks = vi.hoisted(() => ({ store: {} as ChatStore, run: vi.fn(), configured: vi.fn(() => false), opening: { sign: vi.fn(), drop: vi.fn() } }));
vi.mock("./server", () => ({ chatStore: () => mocks.store }));
vi.mock("@/opening/server", () => ({ openingStore: () => mocks.opening }));
vi.mock("./service", () => ({ runCaseAi: mocks.run, CaseAiError: class CaseAiError extends Error {} }));
vi.mock("@/ai/model", () => ({ aiConfigured: mocks.configured }));
import { getCaseResponse, getQuoteResponse, postCaseResponse, postQuoteDropResponse, postQuoteResponse, postQuoteSignResponse } from "./http";
import { defaultOpening, openingDocument } from "@/opening/document";

let state: StoredCase;
beforeEach(() => {
  vi.clearAllMocks();
  state = { id: randomUUID(), projectKey: "willow", messages: [], draft: null, activeMessageId: null };
  mocks.store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn().mockResolvedValue(state),
    getQuote: vi.fn().mockResolvedValue({ projectKey: "willow", opening: defaultOpening("willow"), document: openingDocument("willow"), approval: null, lines: {} }),
    beginAi: vi.fn(), completeAi: vi.fn(), failAi: vi.fn(),
  };
  mocks.run.mockResolvedValue(state);
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3002/api/chat/willow", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002", ...headers } });
}

describe("case chat HTTP boundary", () => {
  it.each(["127.0.0.1:3002", "localhost:3002"])("accepts a discussion from the actual %s browser origin", async (host) => {
    const req = post({ id: randomUUID(), actor: "client", text: "Hello" }, { host, origin: "http://" + host });
    expect((await postCaseResponse(req, "willow")).status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, opaque and forged origins before writing a discussion", async () => {
    for (const origin of [null, "null", "http://localhost:3002", "https://attacker.example"]) {
      const req = post({ id: randomUUID(), actor: "client", text: "Hello" }, { host: "127.0.0.1:3002" });
      if (origin === null) req.headers.delete("origin"); else req.headers.set("origin", origin);
      expect((await postCaseResponse(req, "willow")).status).toBe(403);
    }
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("sets an opaque HttpOnly cookie and supplies no baseline before the client approves V1", async () => {
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow"), "willow");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    const body = await response.json();
    expect(body.quote).toBeNull();
    expect(body.opening).toMatchObject({ status: "draft", lineCount: 26 });
    expect(body.aiConfigured).toBe(false);
  });
  it("retains the session cookie across reloads", async () => {
    const session = randomUUID();
    await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: { cookie: `setti-demo-chat=${session}` } }), "willow");
    expect(mocks.store.getCase).toHaveBeenCalledWith(session, "willow");
  });
  it("returns the session store's latest confirmed quote rather than the static demo V1", async () => {
    const approved = structuredClone(approvedForTest("willow"));
    approved.id = "approved-willow-v3";
    approved.version = 3;
    state.quote = approved;
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow"), "willow");
    const body = await response.json();
    expect(body.quote).toEqual(approved);
    expect(body.quote.id).not.toBe("demo-willow-v1");
  });
  it("saves ordinary discussion and links without invoking AI", async () => {
    const input = { id: randomUUID(), actor: "client", text: "What about this chair? https://shop.example/chair" };
    const response = await postCaseResponse(post(input), "willow");
    expect(response.status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledWith(expect.any(String), "willow", input);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("accepts natural mention requests and retries without appending another message", async () => {
    const id = randomUUID();
    await postCaseResponse(post({ id, actor: "designer", text: "@Coordinator, change it to this one, 4 chairs." }), "willow");
    expect(mocks.run).toHaveBeenCalledWith(mocks.store, expect.any(String), "willow", id);
    vi.mocked(mocks.store.appendMessage).mockClear();
    await postCaseResponse(post({ messageId: id }), "willow", true);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("rejects other origins, unknown cases and client-supplied approval or prices", async () => {
    const input = { id: randomUUID(), actor: "client", text: "@Coordinator change" };
    expect((await postCaseResponse(post(input, { origin: "https://another.example" }), "willow")).status).toBe(403);
    expect((await postCaseResponse(post(input), "not-a-case")).status).toBe(404);
    expect((await postCaseResponse(post({ ...input, approved: true, quote: { unitPriceCents: 1 } }), "willow")).status).toBe(400);
    expect((await postCaseResponse(post({ ...input, actor: "assistant" }), "willow")).status).toBe(400);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("shows a client that a draft is being prepared, never the designer's draft itself", async () => {
    state.draft = { id: randomUUID(), title: "Revised lines from quote V1" } as unknown as StoredCase["draft"];
    const asClient = await (await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: { cookie: "setti-demo-account=sofia" } }), "willow")).json();
    expect(asClient).toMatchObject({ draft: null, draftPreparing: true });
    const asDesigner = await (await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: { cookie: "setti-demo-account=jordan" } }), "willow")).json();
    expect(asDesigner.draft.title).toBe("Revised lines from quote V1");
    expect(asDesigner.draftPreparing).toBeUndefined();
    // Once that draft is sent as a version, the client sees the version card instead.
    state.versions = [{ fromCurrentDraft: true } as unknown as NonNullable<StoredCase["versions"]>[number]];
    const afterSending = await (await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/willow", { headers: { cookie: "setti-demo-account=sofia" } }), "willow")).json();
    expect(afterSending).toMatchObject({ draft: null, draftPreparing: false });
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

function sendQuote(body: unknown, headers: Record<string, string> = {}, key = "willow") {
  return postQuoteResponse(new NextRequest(`http://localhost:3002/api/chat/${key}/quote`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002", ...headers } }), key);
}

describe("quote V1 HTTP boundary", () => {
  it("lets only the designer send, with nothing but a message: the server freezes its own copy", async () => {
    const id = randomUUID();
    expect((await sendQuote({ id, text: "Here is the quote." }, { cookie: "setti-demo-account=jordan" })).status).toBe(200);
    expect(mocks.store.sendQuote).toHaveBeenCalledWith(expect.any(String), "willow", { id, text: "Here is the quote.", sentBy: "Jordan Lee" });
    vi.mocked(mocks.store.sendQuote).mockClear();
    const asClient = await sendQuote({ id, text: "Here is the quote." }, { cookie: "setti-demo-account=sofia" });
    expect(asClient.status).toBe(403);
    expect((await asClient.json()).error).toBe("Only the designer can send a quote.");
    expect((await sendQuote({ id, text: "Here is the quote.", lines: [] })).status).toBe(400);
    expect((await sendQuote({ id, text: "" })).status).toBe(400);
    expect((await sendQuote({ id, text: "Hi" }, { origin: "https://another.example" })).status).toBe(403);
    expect(mocks.store.sendQuote).not.toHaveBeenCalled();
  });
  it("explains why a project without a draft V1 has nothing to send", async () => {
    vi.mocked(mocks.store.sendQuote).mockRejectedValueOnce(Object.assign(new Error("approved"), { code: "NOT_AVAILABLE" }));
    const response = await sendQuote({ id: randomUUID(), text: "Quote" }, {}, "maple");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("NOT_AVAILABLE");
  });
  it("shows a draft V1 to the designer only, and a client only their own project", async () => {
    const quote = (account?: string, key = "willow") => getQuoteResponse(new NextRequest(`http://localhost:3002/api/quotes/${key}`, { headers: account ? { cookie: `setti-demo-account=${account}` } : {} }), key);
    const designer = await quote("jordan");
    expect(designer.status).toBe(200);
    expect((await designer.json()).opening.status).toBe("draft");
    const client = await quote("sofia");
    expect(client.status).toBe(404);
    expect((await client.json()).code).toBe("NOT_SHARED");
    expect((await quote("emma")).status).toBe(403);
    vi.mocked(mocks.store.getQuote).mockResolvedValueOnce({ projectKey: "willow", opening: { ...defaultOpening("willow"), status: "sent", messageId: randomUUID(), sentAt: new Date().toISOString(), sentBy: "Jordan Lee", contentHash: "a".repeat(64) }, document: openingDocument("willow"), approval: null, lines: {} });
    expect((await quote("sofia")).status).toBe(200);
  });
});

describe("quote V1 decisions HTTP boundary", () => {
  const request = (path: string, body: unknown, account?: string) => new NextRequest(`http://localhost:3002/api/quotes/willow/${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002", ...(account ? { cookie: `setti-demo-account=${account}` } : {}) },
  });
  const signature = { signingId: randomUUID(), contentHash: "a".repeat(64), signature: "Sofia Martinez", acknowledged: true, decisions: [{ itemId: "willow-sofa", decision: "declined", note: "Too big." }] };

  it("lets only the project's own client sign, with nothing but the decisions", async () => {
    mocks.opening.sign.mockResolvedValue({ ok: true });
    for (const account of [undefined, "jordan", "emma"]) expect((await postQuoteSignResponse(request("sign", signature, account), "willow")).status).toBe(403);
    expect(mocks.opening.sign).not.toHaveBeenCalled();
    expect((await postQuoteSignResponse(request("sign", { ...signature, decisions: [{ itemId: "willow-sofa", decision: "approved", unitPriceCents: 1 }] }, "sofia"), "willow")).status).toBe(400);
    expect((await postQuoteSignResponse(request("sign", { ...signature, acknowledged: false }, "sofia"), "willow")).status).toBe(400);
    expect((await postQuoteSignResponse(request("sign", signature, "sofia"), "willow")).status).toBe(200);
    expect(mocks.opening.sign).toHaveBeenCalledWith(expect.any(String), "willow", signature);
  });

  it("lets only the designer drop a line, recorded under the designer's name", async () => {
    mocks.opening.drop.mockResolvedValue({ ok: true });
    expect((await postQuoteDropResponse(request("drop", { itemId: "willow-sofa" }, "sofia"), "willow")).status).toBe(403);
    expect(mocks.opening.drop).not.toHaveBeenCalled();
    expect((await postQuoteDropResponse(request("drop", { itemId: "willow-sofa" }, "jordan"), "willow")).status).toBe(200);
    expect(mocks.opening.drop).toHaveBeenCalledWith(expect.any(String), "willow", { itemId: "willow-sofa", by: "Jordan Lee" });
  });

  it("passes a question's line tag through to the store", async () => {
    const input = { id: randomUUID(), actor: "client", text: "Does it come in dark gray?", aboutItemId: "willow-sofa" };
    expect((await postCaseResponse(post(input, { cookie: "setti-demo-account=sofia" }), "willow")).status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledWith(expect.any(String), "willow", input);
  });
});
