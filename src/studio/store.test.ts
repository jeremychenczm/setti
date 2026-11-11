import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { openTestDb, testDatabaseUrl } from "@/db/testing";
import { clientActor, designerActor } from "@/http/testing";
import { studioCase } from "@/demo/studio-cases";
import { studioChatResponse } from "./http";
import { studioModelContext } from "./model";
import { CONTEXT_CHAR_LIMIT } from "@/ai/model";
import { studioThreads } from "./schema";
import { preparedMessages, studioThreadStore } from "./store";

const mock = vi.hoisted(() => ({ requestActor: vi.fn() }));
vi.mock("@/http/actor", () => ({ requestActor: mock.requestActor }));

const bistro = studioCase("alder-bistro")!;
const coffee = studioCase("juniper-coffee")!;

describe("studio chat boundaries", () => {
  it("rejects unknown projects, signed-out visitors, clients and cross-site writes before touching storage", async () => {
    const studio = randomUUID();
    expect((await studioChatResponse(new NextRequest("http://localhost:3002/api/studio/unknown/chat"), "unknown")).status).toBe(404);
    mock.requestActor.mockResolvedValue(null);
    expect((await studioChatResponse(new NextRequest("http://localhost:3002/api/studio/alder-bistro/chat"), bistro.id)).status).toBe(401);
    mock.requestActor.mockResolvedValue(clientActor(studio, ["maple"]));
    expect((await studioChatResponse(new NextRequest("http://localhost:3002/api/studio/alder-bistro/chat"), bistro.id)).status).toBe(403);
    mock.requestActor.mockResolvedValue(designerActor(studio));
    expect((await studioChatResponse(new NextRequest("http://localhost:3002/api/studio/alder-bistro/chat", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: "{}" }), bistro.id)).status).toBe(403);
  });
  it("gives AI the complete selected conversation and separates the prepared ledger from a pending proposal", () => {
    const messages = preparedMessages(bistro);
    const context = JSON.parse(studioModelContext(bistro, messages));
    expect(context.messages.map((message: { text: string }) => message.text)).toEqual(bistro.messages.map((message) => message.text));
    expect(context.preparedStartingContext.currentQuote.status).toBe("approved");
    expect(context.preparedStartingContext.proposal.status).toBe("awaiting_client");
    expect(context.preparedStartingContext.preparedPaymentTotals.netPaid).toBe(180000);
    expect(context.preparedStartingContext.projectId).toBe(bistro.id);
    expect(() => studioModelContext(bistro, [{ ...messages[0], text: "x".repeat(CONTEXT_CHAR_LIMIT + 1) }])).toThrow(/budget/);
  });
});

describe.skipIf(!testDatabaseUrl)("persistent studio conversations", () => {
  let connection: Awaited<ReturnType<typeof openTestDb>>;
  let store: ReturnType<typeof studioThreadStore>;
  const sessions: string[] = [];
  const session = () => { const id = randomUUID(); sessions.push(id); return id; };
  beforeAll(async () => { connection = await openTestDb(); store = studioThreadStore(connection.db); });
  afterAll(async () => {
    if (!connection) return;
    try { if (sessions.length) await connection.db.delete(studioThreads).where(inArray(studioThreads.sessionId, sessions)); }
    finally { await connection.pool.end(); }
  });

  it("saves once across retries and isolates both projects and browser sessions", async () => {
    const id = session();
    const input = { id: randomUUID(), text: "Keep the tile sample for the next site visit." };
    await store.append(id, bistro, input);
    await store.append(id, bistro, input);
    expect((await store.read(id, bistro)).filter((message) => message.id === input.id)).toHaveLength(1);
    expect((await store.read(session(), bistro)).some((message) => message.id === input.id)).toBe(false);
    expect((await store.read(id, coffee)).some((message) => message.id === input.id)).toBe(false);
    await expect(store.append(id, bistro, { ...input, text: "Different content" })).rejects.toThrow(/already been used/);
  });

  it("allows one AI run and one reply even when completion or the POST is repeated", async () => {
    const id = session();
    const input = { id: randomUUID(), text: "@Setti What should we confirm next?" };
    const run = await store.append(id, bistro, input);
    await expect(store.append(id, bistro, { id: randomUUID(), text: "Another message" })).rejects.toThrow(/working/);
    const replies = await Promise.allSettled([store.finish(id, bistro, input.id, run.runId!, { text: "Check the tile sample.", model: "test-provider" }), store.finish(id, bistro, input.id, run.runId!, { text: "Duplicate response", model: "test-provider" })]);
    expect(replies.filter((reply) => reply.status === "fulfilled")).toHaveLength(1);
    expect((await store.read(id, bistro)).filter((message) => message.replyToMessageId === input.id)).toHaveLength(1);
    expect((await store.append(id, bistro, input)).runId).toBeNull();
  });

  it("recovers an interrupted AI request and rejects the old run's late response", async () => {
    const id = session();
    const input = { id: randomUUID(), text: "@Setti Summarise this scope." };
    const old = await store.append(id, bistro, input);
    await connection.db.update(studioThreads).set({ activeSince: new Date(Date.now() - 125000) }).where(and(eq(studioThreads.sessionId, id), eq(studioThreads.projectId, bistro.id)));
    expect((await store.read(id, bistro)).find((message) => message.id === input.id)?.aiState).toBe("failed");
    const next = await store.append(id, bistro, input);
    await expect(store.finish(id, bistro, input.id, old.runId!, { text: "Stale", model: "test-provider" })).rejects.toThrow(/newer/);
    await store.finish(id, bistro, input.id, next.runId!, { text: "Current response", model: "test-provider" });
    expect((await store.read(id, bistro)).filter((message) => message.replyToMessageId === input.id)).toHaveLength(1);
  });

  it("keeps failed requests retryable without letting an old request override newer discussion", async () => {
    const id = session();
    const input = { id: randomUUID(), text: "@Setti Review the wall lining." };
    const first = await store.append(id, bistro, input);
    await store.finish(id, bistro, input.id, first.runId!, { error: "Provider unavailable" });
    const retry = await store.append(id, bistro, input);
    await store.finish(id, bistro, input.id, retry.runId!, { error: "Still unavailable" });
    await store.append(id, bistro, { id: randomUUID(), text: "We will keep the current wall lining." });
    await expect(store.append(id, bistro, input)).rejects.toThrow(/newer discussion/);
  });

  it("keeps completed projects read only at the storage boundary", async () => {
    await expect(store.append(session(), studioCase("harbor-flat")!, { id: randomUUID(), text: "Change this project" })).rejects.toMatchObject({ status: 403 });
  });
});
