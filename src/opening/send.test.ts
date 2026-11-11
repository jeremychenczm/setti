import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chatCases } from "../chat/schema";
import { createChatStore } from "../chat/store";
import type { ChatStore } from "../chat/types";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { documentHash, openingDocument } from "./document";
import { openingQuotes } from "./schema";
import { sampleProject } from "@/demo/sample-projects";
import { createProject } from "@/projects/create";
import { draftSchema, saveDraft } from "@/projects/draft";
import { addTestProject, TEST_KEY, testProject, V1_CENTS } from "@/projects/testing";

describe.skipIf(!testDatabaseUrl)("sending quote V1 from the project chat", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let store: ChatStore;
  let sessionId: string;
  const send = (id = randomUUID(), text = "Here is the full quote for Fernhill Apartment.") => store.sendQuote(sessionId, TEST_KEY, { id, text, sentBy: "Jordan Lee" });

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "opening_quotes", "chat_messages", "chat_cases");
    store = createChatStore(handle.db);
    sessionId = randomUUID();
    await addTestProject(handle.db, sessionId);
  });
  afterAll(() => handle?.pool.end());

  it("starts as a draft V1, then posts one designer message and freezes the server's own copy of V1 with its hash", async () => {
    const draft = await store.getCase(sessionId, TEST_KEY);
    expect(draft.messages).toEqual([]);
    expect(draft.opening).toMatchObject({ status: "draft", messageId: null, contentHash: null, lineCount: 6, totalCents: V1_CENTS });

    const id = randomUUID();
    const state = await send(id);
    expect(state.messages).toEqual([expect.objectContaining({ id, actor: "designer", text: "Here is the full quote for Fernhill Apartment.", aiState: "none" })]);
    const hash = documentHash(openingDocument(testProject));
    expect(state.opening).toMatchObject({ status: "sent", messageId: id, sentBy: "Jordan Lee", contentHash: hash, lineCount: 6, totalCents: V1_CENTS });
    const view = await store.getQuote(sessionId, TEST_KEY);
    expect(view.document).toEqual(openingDocument(testProject));
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
    await store.appendMessage(sessionId, TEST_KEY, { id: used, actor: "designer", text: "Hello Ava" });
    await expect(send(used)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await store.getCase(sessionId, TEST_KEY)).opening?.status).toBe("draft");
  });

  it("keeps a sent V1 frozen in the database and bound to a designer message of its own case", async () => {
    await send();
    await expect(handle.db.update(openingQuotes).set({ sentBy: "Someone else" })).rejects.toThrow();
    await expect(handle.db.delete(openingQuotes)).rejects.toThrow();
    const otherSession = randomUUID();
    const clientMessage = randomUUID();
    await addTestProject(handle.db, otherSession);
    await store.appendMessage(otherSession, TEST_KEY, { id: clientMessage, actor: "client", text: "Hi" });
    const [otherCase] = await handle.db.select().from(chatCases).where(eq(chatCases.sessionId, otherSession));
    const document = openingDocument(testProject);
    await expect(handle.db.insert(openingQuotes).values({ caseId: otherCase.id, messageId: clientMessage, document, contentHash: documentHash(document), sentBy: "Ava Chen" })).rejects.toThrow();
    const [{ count }] = await handle.db.select({ count: sql<number>`count(*)::int` }).from(openingQuotes);
    expect(count).toBe(1);
  });

  it("lets the designer write V1 until it is sent, and sends exactly what was saved", async () => {
    const key = await createProject(handle.db, sessionId, "Avery Stone", { name: "Harbor Loft", subtitle: "" });
    const draft = async () => (await store.getQuote(sessionId, key)).document;
    const line = { name: "Walnut sideboard", category: "furniture" as const, vendor: "Oak & Iron", room: "Dining", sku: "SB-1", specification: "180 cm, oiled walnut",
      quantity: 1, unitLabel: "each", unitPriceCents: 240_000, taxCents: 19_800, freightCents: 9_000, leadTimeDays: 42, returnPolicy: "No returns once made.",
      restockingFeeBps: null, customMade: true, nonReturnable: true, sourceUrl: "https://example.com/sideboard" };
    await expect(store.sendQuote(sessionId, key, { id: randomUUID(), text: "Here is V1.", sentBy: "Avery Stone" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    const first = await saveDraft(handle.db, sessionId, key, { basedOn: documentHash(await draft()), room: "Dining", clientName: "Morgan Lee", lines: [line] });
    const saved = await draft();
    expect(saved).toMatchObject({ room: "Dining", clientName: "Morgan Lee", lines: [{ name: "Walnut sideboard", unitPriceCents: 240_000, source: { kind: "public_reference", url: "https://example.com/sideboard" } }] });
    // A save over a draft changed since is refused, not merged.
    await expect(saveDraft(handle.db, sessionId, key, { basedOn: documentHash(openingDocument(testProject)), room: "", clientName: "", lines: [] })).rejects.toMatchObject({ code: "STALE_DRAFT" });
    // The line keeps its id when edited again.
    await saveDraft(handle.db, sessionId, key, { basedOn: first.hash, room: "Dining", clientName: "Morgan Lee", lines: [{ ...line, itemId: saved.lines[0].itemId, quantity: 2 }] });
    expect((await draft()).lines.map(({ itemId, quantity }) => [itemId, quantity])).toEqual([[saved.lines[0].itemId, 2]]);
    expect(draftSchema.safeParse({ basedOn: first.hash, room: "", clientName: "", lines: [{ ...line, quantity: 0 }] }).success).toBe(false);
    expect(draftSchema.safeParse({ basedOn: first.hash, room: "", clientName: "", lines: [{ ...line, unitPriceCents: -1 }] }).success).toBe(false);

    const unnamed = await saveDraft(handle.db, sessionId, key, { basedOn: documentHash(await draft()), room: "Dining", clientName: "", lines: [{ ...line, itemId: saved.lines[0].itemId, quantity: 2 }] });
    await expect(store.sendQuote(sessionId, key, { id: randomUUID(), text: "Here is V1.", sentBy: "Avery Stone" })).rejects.toMatchObject({ code: "NOT_AVAILABLE", message: expect.stringContaining("prepared for") });
    await saveDraft(handle.db, sessionId, key, { basedOn: unnamed.hash, room: "Dining", clientName: "Morgan Lee", lines: [{ ...line, itemId: saved.lines[0].itemId, quantity: 2 }] });
    const sent = await store.sendQuote(sessionId, key, { id: randomUUID(), text: "Here is V1.", sentBy: "Avery Stone" });
    expect(sent.opening).toMatchObject({ status: "sent", lineCount: 1, totalCents: 2 * 240_000 + 19_800 + 9_000 });
    expect((await store.getQuote(sessionId, key)).document).toEqual(await draft());
    await expect(saveDraft(handle.db, sessionId, key, { basedOn: documentHash(await draft()), room: "", clientName: "", lines: [] })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    // A project that starts from a V1 approved before Setti has no draft to write.
    await store.getCase(sessionId, "maple");
    await expect(saveDraft(handle.db, sessionId, "maple", { basedOn: documentHash(openingDocument(sampleProject("maple")!)), room: "", clientName: "", lines: [] })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });
});
