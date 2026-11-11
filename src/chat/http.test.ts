import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/http/identity";
import { clientActor, designerActor } from "@/http/testing";
import type { ChatStore, StoredCase } from "./types";
import { approvedTestQuote, SOFA, testProject, testQuote } from "../projects/testing";

const mocks = vi.hoisted(() => ({ store: {} as ChatStore, run: vi.fn(), configured: vi.fn(() => false), opening: { sign: vi.fn(), drop: vi.fn() }, requestActor: vi.fn() }));
vi.mock("@/http/actor", () => ({ requestActor: mocks.requestActor }));
vi.mock("./server", () => ({ chatStore: () => mocks.store }));
vi.mock("@/opening/server", () => ({ openingStore: () => mocks.opening }));
vi.mock("./service", () => ({ runCaseAi: mocks.run, CaseAiError: class CaseAiError extends Error {} }));
vi.mock("@/ai/model", () => ({ aiConfigured: mocks.configured }));
import { getCaseResponse, getQuoteResponse, postCaseResponse, postQuoteDropResponse, postQuoteResponse, postQuoteSignResponse } from "./http";
import { defaultOpening, openingDocument } from "@/opening/document";

/** One studio: Jordan designs, Ava is the test project's client and Emma is Maple's. */
const studio = randomUUID();
const jordan = designerActor(studio, { persona: "jordan" });
const ava = clientActor(studio, ["fernhill"], { name: "Ava Chen" });
const emma = clientActor(studio, ["maple"], { persona: "emma" });
const as = (actor: Actor | null) => mocks.requestActor.mockResolvedValue(actor);

let state: StoredCase;
beforeEach(() => {
  vi.clearAllMocks();
  as(jordan);
  state = { id: randomUUID(), projectKey: "fernhill", messages: [], draft: null, activeMessageId: null, opening: defaultOpening(testProject) };
  mocks.store = {
    getCase: vi.fn().mockResolvedValue(state), appendMessage: vi.fn().mockResolvedValue(state), sendQuote: vi.fn().mockResolvedValue(state),
    getQuote: vi.fn().mockResolvedValue({ projectKey: "fernhill", opening: defaultOpening(testProject), document: openingDocument(testProject), approval: null, lines: {} }),
    beginAi: vi.fn(), completeAi: vi.fn(), failAi: vi.fn(),
  };
  mocks.run.mockResolvedValue(state);
});

/** A chat message, sent by the account of the message's role unless a test signs someone else in first. */
function post(body: unknown, headers: Record<string, string> = {}, actor?: Actor) {
  const role = (body as { actor?: string }).actor;
  as(actor ?? (role === "client" ? ava : jordan));
  return new NextRequest("http://localhost:3002/api/chat/fernhill", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002", ...headers } });
}

describe("case chat HTTP boundary", () => {
  it.each(["127.0.0.1:3002", "localhost:3002"])("accepts a discussion from the actual %s browser origin", async (host) => {
    const req = post({ id: randomUUID(), actor: "client", text: "Hello" }, { host, origin: "http://" + host });
    expect((await postCaseResponse(req, "fernhill")).status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, opaque and forged origins before writing a discussion", async () => {
    for (const origin of [null, "null", "http://localhost:3002", "https://attacker.example"]) {
      const req = post({ id: randomUUID(), actor: "client", text: "Hello" }, { host: "127.0.0.1:3002" });
      if (origin === null) req.headers.delete("origin"); else req.headers.set("origin", origin);
      expect((await postCaseResponse(req, "fernhill")).status).toBe(403);
    }
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("sets no cookie and supplies no baseline before the client approves V1", async () => {
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body.quote).toBeNull();
    expect(body.opening).toMatchObject({ status: "draft", lineCount: 6 });
    expect(body.aiConfigured).toBe(false);
  });
  it("reads the project from the studio that owns it, for its designer and its client", async () => {
    await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill");
    expect(mocks.store.getCase).toHaveBeenLastCalledWith(studio, "fernhill");
    const elsewhere = randomUUID();
    as(clientActor(elsewhere, ["fernhill"]));
    await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill");
    expect(mocks.store.getCase).toHaveBeenLastCalledWith(elsewhere, "fernhill");
  });
  it("asks a signed-out visitor to sign in, before reading or writing anything", async () => {
    as(null);
    const read = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill");
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ code: "SIGN_IN_REQUIRED" });
    const req = post({ id: randomUUID(), actor: "client", text: "Hello" });
    as(null);
    expect((await postCaseResponse(req, "fernhill")).status).toBe(401);
    expect(mocks.store.getCase).not.toHaveBeenCalled();
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("returns the session store's latest confirmed quote rather than the static demo V1", async () => {
    const approved = structuredClone(approvedTestQuote());
    approved.id = "approved-fernhill-v3";
    approved.version = 3;
    state.quote = approved;
    const response = await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill");
    const body = await response.json();
    expect(body.quote).toEqual(approved);
    expect(body.quote.id).not.toBe(testQuote.id);
  });
  it("saves ordinary discussion and links without invoking AI", async () => {
    const input = { id: randomUUID(), actor: "client", text: "What about this chair? https://shop.example/chair" };
    const response = await postCaseResponse(post(input), "fernhill");
    expect(response.status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledWith(studio, "fernhill", input);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("accepts natural mention requests and retries without appending another message", async () => {
    const id = randomUUID();
    await postCaseResponse(post({ id, actor: "designer", text: "@Setti, change it to this one, 4 chairs." }), "fernhill");
    expect(mocks.run).toHaveBeenCalledWith(mocks.store, studio, "fernhill", id);
    vi.mocked(mocks.store.appendMessage).mockClear();
    await postCaseResponse(post({ messageId: id }), "fernhill", true);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("rejects other origins, unknown cases and client-supplied approval or prices", async () => {
    const input = { id: randomUUID(), actor: "client", text: "@Setti change" };
    expect((await postCaseResponse(post(input, { origin: "https://another.example" }), "fernhill")).status).toBe(403);
    expect((await postCaseResponse(post(input), "Not a project")).status).toBe(404);
    // A well-formed key the studio has no project for.
    as(jordan);
    vi.mocked(mocks.store.getCase).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "PROJECT_NOT_FOUND" }));
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/kitchen"), "kitchen")).status).toBe(404);
    expect((await postCaseResponse(post({ ...input, approved: true, quote: { unitPriceCents: 1 } }), "fernhill")).status).toBe(400);
    expect((await postCaseResponse(post({ ...input, actor: "assistant" }), "fernhill")).status).toBe(400);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
  it("shows a client that a draft is being prepared, never the designer's draft itself", async () => {
    state.draft = { id: randomUUID(), title: "Revised lines from quote V1" } as unknown as StoredCase["draft"];
    const read = (actor: Actor) => { as(actor); return getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill"); };
    const asClient = await (await read(ava)).json();
    expect(asClient).toMatchObject({ draft: null, draftPreparing: true });
    const asDesigner = await (await read(jordan)).json();
    expect(asDesigner.draft.title).toBe("Revised lines from quote V1");
    expect(asDesigner.draftPreparing).toBeUndefined();
    // Once that draft is sent as a version, the client sees the version card instead.
    state.versions = [{ fromCurrentDraft: true } as unknown as NonNullable<StoredCase["versions"]>[number]];
    const afterSending = await (await read(ava)).json();
    expect(afterSending).toMatchObject({ draft: null, draftPreparing: false });
  });
  it("limits a client to their own projects, and everyone to their own role", async () => {
    as(ava);
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/maple"), "maple")).status).toBe(403);
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill")).status).toBe(200);
    as(designerActor());
    expect((await getCaseResponse(new NextRequest("http://localhost:3002/api/chat/fernhill"), "fernhill")).status).toBe(200);
    expect(mocks.store.getCase).toHaveBeenLastCalledWith(expect.not.stringMatching(studio), "fernhill");
    const asDesigner = await postCaseResponse(post({ id: randomUUID(), actor: "designer", text: "Hello" }, {}, ava), "fernhill");
    expect(asDesigner.status).toBe(403);
    expect((await asDesigner.json()).error).toContain("Ava Chen");
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "Hello" }, {}, emma), "fernhill")).status).toBe(403);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "Hello" }, {}, ava), "fernhill")).status).toBe(200);
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "Hello" }, {}, jordan), "fernhill")).status).toBe(403);
  });
  it("bounds request bodies before touching storage", async () => {
    expect((await postCaseResponse(post({ id: randomUUID(), actor: "client", text: "x".repeat(33000) }), "fernhill")).status).toBe(413);
    expect(mocks.store.appendMessage).not.toHaveBeenCalled();
  });
});

function sendQuote(body: unknown, headers: Record<string, string> = {}, key = "fernhill", actor: Actor = jordan) {
  as(actor);
  return postQuoteResponse(new NextRequest(`http://localhost:3002/api/chat/${key}/quote`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002", ...headers } }), key);
}

describe("quote V1 HTTP boundary", () => {
  it("lets only the designer send, with nothing but a message: the server freezes its own copy", async () => {
    const id = randomUUID();
    expect((await sendQuote({ id, text: "Here is the quote." })).status).toBe(200);
    expect(mocks.store.sendQuote).toHaveBeenCalledWith(studio, "fernhill", { id, text: "Here is the quote.", sentBy: "Jordan Lee" });
    vi.mocked(mocks.store.sendQuote).mockClear();
    const asClient = await sendQuote({ id, text: "Here is the quote." }, {}, "fernhill", ava);
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
    const quote = (actor: Actor, key = "fernhill") => { as(actor); return getQuoteResponse(new NextRequest(`http://localhost:3002/api/quotes/${key}`), key); };
    const designer = await quote(jordan);
    expect(designer.status).toBe(200);
    expect((await designer.json()).opening.status).toBe("draft");
    const client = await quote(ava);
    expect(client.status).toBe(404);
    expect((await client.json()).code).toBe("NOT_SHARED");
    expect((await quote(emma)).status).toBe(403);
    vi.mocked(mocks.store.getQuote).mockResolvedValueOnce({ projectKey: "fernhill", opening: { ...defaultOpening(testProject), status: "sent", messageId: randomUUID(), sentAt: new Date().toISOString(), sentBy: "Jordan Lee", contentHash: "a".repeat(64) }, document: openingDocument(testProject), approval: null, lines: {} });
    expect((await quote(ava)).status).toBe(200);
  });
});

describe("quote V1 decisions HTTP boundary", () => {
  const request = (path: string, body: unknown, actor: Actor | null) => {
    as(actor);
    return new NextRequest(`http://localhost:3002/api/quotes/fernhill/${path}`, {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost:3002" },
    });
  };
  const signature = { signingId: randomUUID(), contentHash: "a".repeat(64), signature: "Ava Chen", acknowledged: true, decisions: [{ itemId: SOFA, decision: "declined", note: "Too big." }] };

  it("lets only the project's own client sign, with nothing but the decisions", async () => {
    mocks.opening.sign.mockResolvedValue({ ok: true });
    expect((await postQuoteSignResponse(request("sign", signature, null), "fernhill")).status).toBe(401);
    for (const actor of [jordan, emma]) expect((await postQuoteSignResponse(request("sign", signature, actor), "fernhill")).status).toBe(403);
    expect(mocks.opening.sign).not.toHaveBeenCalled();
    expect((await postQuoteSignResponse(request("sign", { ...signature, decisions: [{ itemId: SOFA, decision: "approved", unitPriceCents: 1 }] }, ava), "fernhill")).status).toBe(400);
    expect((await postQuoteSignResponse(request("sign", { ...signature, acknowledged: false }, ava), "fernhill")).status).toBe(400);
    expect((await postQuoteSignResponse(request("sign", signature, ava), "fernhill")).status).toBe(200);
    expect(mocks.opening.sign).toHaveBeenCalledWith(studio, "fernhill", signature);
  });

  it("lets only the designer drop a line, recorded under the designer's name", async () => {
    mocks.opening.drop.mockResolvedValue({ ok: true });
    expect((await postQuoteDropResponse(request("drop", { itemId: SOFA }, ava), "fernhill")).status).toBe(403);
    expect(mocks.opening.drop).not.toHaveBeenCalled();
    expect((await postQuoteDropResponse(request("drop", { itemId: SOFA }, jordan), "fernhill")).status).toBe(200);
    expect(mocks.opening.drop).toHaveBeenCalledWith(studio, "fernhill", { itemId: SOFA, by: "Jordan Lee" });
  });

  it("passes a question's line tag through to the store", async () => {
    const input = { id: randomUUID(), actor: "client", text: "Does it come in dark gray?", aboutItemId: SOFA };
    expect((await postCaseResponse(post(input, {}, ava), "fernhill")).status).toBe(200);
    expect(mocks.store.appendMessage).toHaveBeenCalledWith(studio, "fernhill", input);
  });
});
