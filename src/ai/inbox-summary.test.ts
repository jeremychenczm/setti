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
