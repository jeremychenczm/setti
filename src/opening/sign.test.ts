import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import type { ChatStore } from "../chat/types";
import { approvals } from "../db/schema";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { confirmScriptedChanges } from "../try/scripted-change";
import { createOpeningStore } from "./store";
import { signOpeningForTest } from "./testing";
import type { QuoteView } from "./types";

const SOFA = "willow-sofa", TILE = "willow-entry-tile", CHAIR = "willow-dining-chair";

describe.skipIf(!testDatabaseUrl)("signing quote V1 line by line", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let chat: ChatStore;
  let opening: ReturnType<typeof createOpeningStore>;
  let session: string;

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => {
    await truncate(handle.db, "opening_withdrawals", "opening_quotes", "change_orders", "pricing_reviews", "pricing_cases", "chat_messages", "chat_cases", "approvals", "revision_lines", "revisions", "items", "projects");
    chat = createChatStore(handle.db);
    opening = createOpeningStore(handle.db);
    session = randomUUID();
  });
  afterAll(() => handle?.pool.end());

  /** Sends V1, then signs every line approved except the sofa (declined) and the entry tile (left undecided). */
  async function signMostLines(): Promise<QuoteView> {
    await chat.sendQuote(session, "willow", { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
    const view = await chat.getQuote(session, "willow");
    const decisions = view.document.lines.filter((line) => line.itemId !== TILE).map((line) => line.itemId === SOFA
      ? { itemId: line.itemId, decision: "declined" as const, note: "Too big for the room." }
      : { itemId: line.itemId, decision: "approved" as const });
    return signOpeningForTest(handle.db, session, "willow", decisions);
  }

  function sign(view: QuoteView, decisions: { itemId: string; decision: "approved" | "declined"; note?: string }[], overrides: Partial<Parameters<typeof opening.sign>[2]> = {}) {
    return opening.sign(session, "willow", { signingId: randomUUID(), contentHash: view.opening.contentHash!, signature: "Sofia Martinez", acknowledged: true, decisions, ...overrides });
  }

  it("makes only the approved lines the baseline, each carrying the client's signed decision", async () => {
    const view = await signMostLines();
    expect(view.opening).toMatchObject({ status: "approved", closed: false, progress: { approved: 24, declined: 1, withdrawn: 0, pending: 1 } });
    expect(view.lines[SOFA]).toMatchObject({ state: "declined", note: "Too big for the room.", by: "Sofia Martinez" });
    expect(view.lines[TILE].state).toBe("pending");

    const state = await chat.getCase(session, "willow");
    expect(state.quote!.lines).toHaveLength(24);
    expect(state.quote!.lines.map((line) => line.itemId)).not.toContain(SOFA);
    expect(state.quote!.lines.every((line) => line.approval.approvedBy === "Sofia Martinez" && line.approval.signature === "Sofia Martinez")).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ actor: "assistant", model: "system" });
    expect(state.messages.at(-1)!.text).toMatch(/^Sofia Martinez signed quote V1: approved 24 lines \(\$[\d,.]+\) and declined 1 line\. 1 line still undecided\. No payment has been made\.$/);
  });

  it("takes undecided lines in a later signature and never decides a line twice", async () => {
    const view = await signMostLines();
    const later = await sign(view, [{ itemId: TILE, decision: "approved" }]);
    expect(later.opening.progress).toMatchObject({ approved: 25, pending: 0 });
    expect((await chat.getCase(session, "willow")).quote!.lines).toHaveLength(25);
    await expect(sign(later, [{ itemId: SOFA, decision: "approved" }])).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(sign(later, [{ itemId: CHAIR, decision: "declined", note: "Changed my mind." }])).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("records a retried signature once and insists on the exact name, the sent content and a decline reason", async () => {
    await chat.sendQuote(session, "willow", { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
    const view = await chat.getQuote(session, "willow");
    await expect(sign(view, [{ itemId: CHAIR, decision: "approved" }], { signature: "sofia martinez" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sign(view, [{ itemId: CHAIR, decision: "approved" }], { contentHash: "0".repeat(64) })).rejects.toMatchObject({ code: "CONTENT_CHANGED" });
    await expect(sign(view, [{ itemId: SOFA, decision: "declined", note: "  " }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(sign(view, [{ itemId: CHAIR, decision: "approved" }, { itemId: CHAIR, decision: "approved" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const signingId = randomUUID();
    await sign(view, [{ itemId: CHAIR, decision: "approved" }], { signingId });
    await sign(view, [{ itemId: CHAIR, decision: "approved" }], { signingId });
    expect(await handle.db.select().from(approvals).where(eq(approvals.signingId, signingId))).toHaveLength(1);
    expect((await chat.getCase(session, "willow")).messages.filter((message) => message.model === "system")).toHaveLength(1);
  });

  it("keeps signed decisions as records the database will not change or delete", async () => {
    await signMostLines();
    await expect(handle.db.update(approvals).set({ decision: "approved" })).rejects.toThrow();
    await expect(handle.db.delete(approvals)).rejects.toThrow();
  });

  it("lets the designer drop a declined or undecided line, never an approved one", async () => {
    const view = await signMostLines();
    const dropped = await opening.drop(session, "willow", { itemId: SOFA, by: "Jordan Lee" });
    expect(dropped.lines[SOFA]).toMatchObject({ state: "withdrawn", by: "Jordan Lee", note: "Too big for the room." });
    const withdrawn = await opening.drop(session, "willow", { itemId: TILE, by: "Jordan Lee" });
    expect(withdrawn.opening.progress).toMatchObject({ approved: 24, declined: 0, withdrawn: 2, pending: 0 });
    await expect(opening.drop(session, "willow", { itemId: CHAIR, by: "Jordan Lee" })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(sign(view, [{ itemId: TILE, decision: "approved" }])).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    const texts = (await chat.getCase(session, "willow")).messages.map((message) => message.text);
    expect(texts).toContain('Jordan Lee dropped Three-seat sofa from quote V1. The client had declined it: "Too big for the room.".');
    expect(texts).toContain("Jordan Lee withdrew Porcelain floor tile from quote V1 before the client decided on it.");
  });

  it("tags a question with a line of the sent V1 only", async () => {
    const ask = (aboutItemId: string) => chat.appendMessage(session, "willow", { id: randomUUID(), actor: "client", text: "Does the sofa come in dark gray?", aboutItemId });
    await expect(ask(SOFA)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await chat.sendQuote(session, "willow", { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
    const asked = await ask(SOFA);
    expect(asked.messages.at(-1)!.aboutItemId).toBe(SOFA);
    expect((await chat.getQuote(session, "willow")).lines[SOFA].questions).toBe(1);
    await expect(ask("willow-not-a-line")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("carries undecided lines into the next version, then closes V1", async () => {
    const view = await signMostLines();
    const v2 = await confirmScriptedChanges(handle.db, session, "willow", [{ action: "quantity" as const, itemId: CHAIR, quantity: 6 }], { confirm: false });
    expect(v2.baselineLines).toHaveLength(24);
    expect(v2.changes.find((change) => change.fromV1)?.fromV1).toEqual({ itemId: TILE, kind: "carried", reason: null });
    expect(v2.lines.find((line) => line.itemId === TILE)).toMatchObject({ name: "Porcelain floor tile", quantity: 4, unitPriceCents: 4_635 });
    expect(v2.lines.map((line) => line.itemId)).not.toContain(SOFA);
    expect((await chat.getQuote(session, "willow")).opening.closed).toBe(true);
    await expect(opening.drop(session, "willow", { itemId: SOFA, by: "Jordan Lee" })).rejects.toMatchObject({ code: "CLOSED" });
    await expect(opening.revise(session, "willow", { itemId: SOFA })).rejects.toMatchObject({ code: "CLOSED" });
    await expect(sign(view, [{ itemId: TILE, decision: "approved" }])).rejects.toMatchObject({ code: "CLOSED" });
  });
});
