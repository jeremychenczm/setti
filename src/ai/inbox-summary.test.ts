import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "../db/testing";
import { summarizeInbox, verifySummary, type SummaryModel } from "./inbox-summary";

const facts = [
  { id: "money-now", text: "In Maple Ave: $1,000.00 charged in total, $3,710.00 on hold now, $0.00 refunded in total." },
  { id: "op-1", text: "Round dining table: $1,250.00 put on hold on Nov 1." },
  { id: "op-2", text: "Three-seat sofa: $2,400.00 hold released on Nov 1." },
];

describe("checking an inbox summary against its facts", () => {
  it("accepts sentences whose amounts and claims come from the facts they cite", () => {
    expect(verifySummary(facts, [
      { text: "You have $3,710.00 on hold now and $1,000.00 charged so far.", factIds: ["money-now"] },
      { text: "The $2,400.00 hold for the original sofa was released.", factIds: ["op-2"] },
    ])).toEqual([]);
  });

  it("refuses invented amounts, unknown facts, unrecorded claims and PayPal ids", () => {
    expect(verifySummary(facts, [{ text: "You were charged $4,710.00.", factIds: ["money-now"] }])).toEqual([expect.stringMatching(/states \$4710\.00, which none of its cited facts records/)]);
    expect(verifySummary(facts, [{ text: "All good.", factIds: ["nope"] }])).toEqual(["Sentence 1 cites a fact id that does not exist."]);
    expect(verifySummary(facts, [{ text: "Your table was refunded.", factIds: ["op-1"] }])).toEqual([expect.stringMatching(/speaks of a refund without citing a fact that records one/)]);
    expect(verifySummary(facts, [{ text: "The hold 5MG97505980000051 is in place.", factIds: ["op-1"] }])).toEqual([expect.stringMatching(/looks like a PayPal id/)]);
  });
});

describe("checking what a client summary says is on hold now", () => {
  const client = [
    { id: "money-now", text: "In Maple Ave: $2,200.00 charged in total, $5,530.00 on hold now, $0.00 refunded in total." },
    { id: "now-1", text: "Now · Dining sideboard: nothing on hold; $1,200.00 charged." },
    { id: "now-2", text: "Now · Fixed six-person dining table: $1,400.00 on hold." },
    { id: "now-3", text: "Now · Three-seat sofa: $2,400.00 on hold." },
    { id: "op-2", text: "Earlier · Nov 1, 7:50 PM · Dining sideboard: $1,200.00 put on hold." },
    { id: "op-3", text: "Earlier · Nov 1, 7:50 PM · Dining sideboard: $1,200.00 charged." },
  ];
  // Shown to a client on Nov 2, before facts said where each item stands now: the sideboard had been charged seconds after its hold.
  const shownOnNov2 = "$5,530.00 is on hold now, including $2,400.00 for the three-seat sofa, $1,400.00 for the dining table and $1,200.00 for the dining sideboard.";

  it("refuses the Nov 2 summary, whichever records it cites", () => {
    expect(verifySummary(client, [{ text: shownOnNov2, factIds: ["money-now", "op-2"] }])).toContainEqual(expect.stringMatching(/says \$1,200\.00 is on hold now, but no "Now ·" fact or total it cites has \$1,200\.00 on hold/));
    expect(verifySummary(client, [{ text: shownOnNov2, factIds: ["money-now", "now-1", "now-2", "now-3"] }])).toEqual([expect.stringMatching(/says \$1,200\.00 is on hold now/)]);
  });

  it("accepts what is held now from the Now facts, and history told from earlier records", () => {
    expect(verifySummary(client, [
      { text: "In Maple Ave, $2,200.00 has been charged in total, $5,530.00 is on hold now, and $0.00 has been refunded.", factIds: ["money-now"] },
      { text: "Holds include the three-seat sofa ($2,400.00) and the dining table ($1,400.00).", factIds: ["now-2", "now-3"] },
      { text: "The dining sideboard was charged $1,200.00 right after its hold.", factIds: ["op-2", "op-3"] },
    ])).toEqual([]);
  });

  it("asks for a Now fact when only earlier records back a claim about today", () => {
    expect(verifySummary(client, [{ text: "The three-seat sofa is still held.", factIds: ["op-2"] }])).toEqual([expect.stringMatching(/without citing the total or a "Now ·" fact/)]);
  });

  it("leaves the designer's reminders, which have no Now facts, as before", () => {
    const reminders = [{ id: "r-1", text: "Maple Ave · Not ordered yet: Compact sofa. Held for 3 days; record the supplier's confirmation." }];
    expect(verifySummary(reminders, [{ text: "The compact sofa is held and still needs its order.", factIds: ["r-1"] }])).toEqual([]);
  });
});

describe.skipIf(!testDatabaseUrl)("writing the inbox summary", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let session: string;
  beforeAll(async () => { handle = await openTestDb(); vi.stubEnv("ANTHROPIC_API_KEY", "test-key"); });
  beforeEach(async () => { await truncate(handle.db, "inbox_summaries"); session = randomUUID(); });
  afterAll(() => { vi.unstubAllEnvs(); return handle?.pool.end(); });

  const request = { audience: "client" as const, reader: "Emma (the client)", facts };
  const good = { sentences: [{ text: "You have $3,710.00 on hold now.", factIds: ["money-now"] }], model: "test-model" };

  it("writes once per set of facts and serves it from the cache afterwards", async () => {
    const model = vi.fn<SummaryModel>().mockResolvedValue(good);
    expect(await summarizeInbox(handle.db, session, request, model)).toMatchObject({ summary: { sentences: good.sentences, model: "test-model" }, reason: null });
    expect(await summarizeInbox(handle.db, session, request, model)).toMatchObject({ summary: { sentences: good.sentences } });
    expect(model).toHaveBeenCalledTimes(1);
    expect(await summarizeInbox(handle.db, session, { ...request, facts: [] }, model)).toEqual({ summary: null, reason: null });
  });

  it("sends the problems back once, and shows no summary when the rewrite fails too", async () => {
    const bad = { sentences: [{ text: "You were charged $9,999.00.", factIds: ["money-now"] }], model: "test-model" };
    const fixed = vi.fn<SummaryModel>().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    expect((await summarizeInbox(handle.db, session, request, fixed)).summary).toMatchObject({ sentences: good.sentences });
    expect(fixed.mock.calls[1][0].previousAttemptProblems).toEqual([expect.stringMatching(/\$9999\.00/)]);

    const stubborn = vi.fn<SummaryModel>().mockResolvedValue(bad);
    const other = { ...request, reader: "Sofia (the client)" };
    expect(await summarizeInbox(handle.db, session, other, stubborn)).toEqual({ summary: null, reason: expect.stringMatching(/did not pass its check/) });
    expect(await summarizeInbox(handle.db, session, other, stubborn)).toEqual({ summary: null, reason: expect.stringMatching(/did not pass its check/) });
    expect(stubborn).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed call, so the next view tries again", async () => {
    const flaky = vi.fn<SummaryModel>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(good);
    expect(await summarizeInbox(handle.db, session, request, flaky)).toEqual({ summary: null, reason: expect.stringMatching(/not available right now/) });
    expect((await summarizeInbox(handle.db, session, request, flaky)).summary).toMatchObject({ sentences: good.sentences });
  });
});
