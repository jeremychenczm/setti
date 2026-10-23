import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "../chat/store";
import type { ChatStore } from "../chat/types";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { createPricingStore } from "../pricing/store";
import { createOpeningStore } from "./store";
import { signOpeningForTest } from "./testing";

const SOFA = "willow-sofa", COVER = "willow-cushion-cover", RUG = "willow-area-rug", CHAIR = "willow-dining-chair";

describe.skipIf(!testDatabaseUrl)("revising declined V1 lines by hand", () => {
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

  /** The sofa and rug are declined, the cushion covers left undecided, everything else approved. */
  async function signMostLines() {
    await chat.sendQuote(session, "willow", { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
    const view = await chat.getQuote(session, "willow");
    const declined: Record<string, string> = { [SOFA]: "Too big for the room.", [RUG]: "Prefer wool." };
    return signOpeningForTest(handle.db, session, "willow", view.document.lines.filter((line) => line.itemId !== COVER)
      .map((line) => declined[line.itemId] ? { itemId: line.itemId, decision: "declined" as const, note: declined[line.itemId] } : { itemId: line.itemId, decision: "approved" as const }));
  }

  it("starts a designer draft with the declined line filled in from V1 and every undecided line carried", async () => {
    await signMostLines();
    const { draft } = await opening.revise(session, "willow", { itemId: SOFA });
    expect(draft).toMatchObject({ model: "designer", basedOnVersion: 1 });
    expect(draft.changes.map((change) => [change.action, change.fromV1?.itemId, change.fromV1?.kind, change.fromV1?.reason])).toEqual([
      ["add", SOFA, "revised", "Too big for the room."],
      ["add", COVER, "carried", null],
    ]);
    expect(draft.changes[0].after).toMatchObject({ name: "Three-seat sofa", unitPriceCents: 79_900, quantity: 1 });

    const again = await opening.revise(session, "willow", { itemId: SOFA });
    expect(again.draft.changes).toHaveLength(2);
    const both = await opening.revise(session, "willow", { itemId: RUG });
    expect(both.draft.id).toBe(draft.id);
    expect(both.draft.changes.map((change) => change.fromV1?.itemId)).toEqual([SOFA, COVER, RUG]);
    expect((await chat.getCase(session, "willow")).draft?.id).toBe(draft.id);

    await expect(opening.revise(session, "willow", { itemId: CHAIR })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    await expect(opening.revise(session, "willow", { itemId: COVER })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  });

  it("fills the pricing review from V1 and freezes the client-facing origin into the new version", async () => {
    await signMostLines();
    await opening.revise(session, "willow", { itemId: SOFA });
    const pricing = createPricingStore(handle.db);
    const workspace = await pricing.getWorkspace(session, "willow");
    const input = structuredClone(workspace.review!.input);
    const [sofa, cover] = input.changes;
    expect(sofa.after).toMatchObject({ taxCents: 6_991, freightCents: 9_900, room: "Living room", currency: "USD" });
    expect(sofa.after!.returnPolicy).toContain("Demo supplier terms");
    expect(cover.priceEvidence).toContain("Carried over unchanged from quote V1");

    sofa.after = { ...sofa.after!, name: "Compact two-seat sofa", sku: "ARF-SOFA-2S-BG", specification: "Beige-gray woven fabric · 72 W in", unitPriceCents: 64_900, taxCents: 5_679 };
    input.changes = input.changes.map((change) => ({ ...change, confirmed: true }));
    input.terms = "The compact sofa replaces the declined three-seat sofa. The cushion covers still need your decision.";
    const saved = await pricing.saveReview(session, "willow", { sourceDraftId: workspace.sourceDraft!.id, sourceDraftRevision: workspace.sourceDraft!.revision, expectedVersion: null, input });
    expect(saved.preview?.problems).toEqual([]);
    const issued = await pricing.issueReview(session, "willow", { reviewId: saved.review!.id, expectedVersion: saved.review!.version });
    expect(issued.order.changes.map((change) => change.fromV1)).toEqual([
      { itemId: SOFA, kind: "revised", reason: "Too big for the room." },
      { itemId: COVER, kind: "carried", reason: null },
    ]);
    expect(issued.order.lines.find((line) => line.name === "Compact two-seat sofa")?.unitPriceCents).toBe(64_900);
    expect(issued.order.changes[0].changesFromV1?.map((change) => change.label)).toEqual(["Name", "SKU", "Specification", "Unit price", "Tax"]);
    expect(issued.order.changes[1].changesFromV1).toEqual([]);
    expect(issued.order.lines.find((line) => line.itemId === COVER)).toBeDefined();
    expect((await chat.getQuote(session, "willow")).opening.closed).toBe(true);
  });

  it("keeps the draft in step when the client decides a carried line or the designer drops a revised one", async () => {
    const view = await signMostLines();
    await opening.revise(session, "willow", { itemId: SOFA });
    await opening.sign(session, "willow", { signingId: randomUUID(), contentHash: view.opening.contentHash!, signature: "Sofia Martinez", acknowledged: true, decisions: [{ itemId: COVER, decision: "declined", note: "Not needed." }] });
    expect((await chat.getCase(session, "willow")).draft!.changes.map((change) => change.fromV1?.itemId)).toEqual([SOFA]);
    await opening.drop(session, "willow", { itemId: SOFA, by: "Jordan Lee" });
    expect((await chat.getCase(session, "willow")).draft!.changes).toEqual([]);
  });

  it("refuses to revise before the client approves any line, since a new version starts from approved lines", async () => {
    await chat.sendQuote(session, "willow", { id: randomUUID(), text: "Here is quote V1.", sentBy: "Jordan Lee" });
    const view = await chat.getQuote(session, "willow");
    await signOpeningForTest(handle.db, session, "willow", [{ itemId: SOFA, decision: "declined", note: "Too big." }]);
    await expect(opening.revise(session, "willow", { itemId: SOFA })).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
    expect(view.opening.status).toBe("sent");
  });
});
