import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chatCases } from "../chat/schema";
import { createChatStore } from "../chat/store";
import type { ChatStore } from "../chat/types";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { documentHash, openingDocument } from "./document";
import { openingQuotes } from "./schema";

describe.skipIf(!testDatabaseUrl)("sending quote V1 from the project chat", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let store: ChatStore;
  let sessionId: string;
  const send = (id = randomUUID(), text = "Here is the full quote for Willow Residence.") => store.sendQuote(sessionId, "willow", { id, text, sentBy: "Jordan Lee" });

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "opening_quotes", "chat_messages", "chat_cases");
    store = createChatStore(handle.db);
    sessionId = randomUUID();
  });
  afterAll(() => handle?.pool.end());

  it("starts as an empty chat with a draft V1 the client cannot see yet", async () => {
    const state = await store.getCase(sessionId, "willow");
    expect(state.messages).toEqual([]);
    expect(state.opening).toMatchObject({ status: "draft", messageId: null, contentHash: null, lineCount: 26, totalCents: 1_517_489 });
    expect((await store.getQuote(sessionId, "willow")).opening.status).toBe("draft");
  });

  it("posts one designer message and freezes the server's own copy of V1 with its hash", async () => {
    const id = randomUUID();
    const state = await send(id);
    expect(state.messages).toEqual([expect.objectContaining({ id, actor: "designer", text: "Here is the full quote for Willow Residence.", aiState: "none" })]);
    const hash = documentHash(openingDocument("willow"));
    expect(state.opening).toMatchObject({ status: "sent", messageId: id, sentBy: "Jordan Lee", contentHash: hash, lineCount: 26 });
    const view = await store.getQuote(sessionId, "willow");
    expect(view.document).toEqual(openingDocument("willow"));
    expect(view.approval).toBeNull();
    expect(documentHash(view.document)).toBe(view.opening.contentHash);
  });

  it("changes nothing when the same send is retried, clicked twice or sent from a second window", async () => {
    const id = randomUUID();
    await send(id);
    await send(id);
    const [, second] = await Promise.all([send(), send()]);
    expect(second.messages).toHaveLength(1);
    expect(second.opening?.messageId).toBe(id);
    expect(await handle.db.select().from(openingQuotes)).toHaveLength(1);
  });

  it("refuses a project that starts from an approved quote, an empty message and a reused message id", async () => {
    await expect(store.sendQuote(sessionId, "maple", { id: randomUUID(), text: "Quote", sentBy: "Jordan Lee" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(send(randomUUID(), "   ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const used = randomUUID();
    await store.appendMessage(sessionId, "willow", { id: used, actor: "designer", text: "Hello Sofia" });
    await expect(send(used)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await store.getCase(sessionId, "willow")).opening?.status).toBe("draft");
  });

  it("keeps a sent V1 frozen in the database and bound to a designer message of its own case", async () => {
    await send();
    await expect(handle.db.update(openingQuotes).set({ sentBy: "Someone else" })).rejects.toThrow();
    await expect(handle.db.delete(openingQuotes)).rejects.toThrow();
    const otherSession = randomUUID();
    const clientMessage = randomUUID();
    await store.appendMessage(otherSession, "willow", { id: clientMessage, actor: "client", text: "Hi" });
    const [otherCase] = await handle.db.select().from(chatCases).where(eq(chatCases.sessionId, otherSession));
    const document = openingDocument("willow");
    await expect(handle.db.insert(openingQuotes).values({ caseId: otherCase.id, messageId: clientMessage, document, contentHash: documentHash(document), sentBy: "Sofia Martinez" })).rejects.toThrow();
    const [{ count }] = await handle.db.select({ count: sql<number>`count(*)::int` }).from(openingQuotes);
    expect(count).toBe(1);
  });
});
