import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freezeRevision } from "../pricing/bridge";
import { approvals, items, projects, revisionLines, revisions } from "./schema";
import { openTestDb, testDatabaseUrl, truncate } from "./testing";

/** Freezes and sends a draft revision in its own transaction; returns the content hash approvals must carry. */
const sendRevision = (db: Awaited<ReturnType<typeof openTestDb>>["db"], revisionId: string) =>
  db.transaction((tx) => freezeRevision(tx, revisionId));

/** Drizzle wraps driver errors; the database's own message is on `cause`. */
async function expectRejected(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the database to reject this").toBeDefined();
  const cause = (error as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? (error as Error).message).toMatch(pattern);
}

describe.skipIf(!testDatabaseUrl)("quote revisions", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let projectId: string;
  let chairId: string;
  let rugId: string;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  afterAll(() => handle?.pool.end());

  beforeEach(async () => {
    await truncate(handle.db, "approvals", "revision_lines", "revisions", "items", "projects");
    const [project] = await handle.db.insert(projects).values({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park" }).returning();
    projectId = project.id;
    const [chair, rug] = await handle.db
      .insert(items)
      .values([
        { projectId, name: "Lounge chair", vendor: "Hart & Co" },
        { projectId, name: "Wool rug", vendor: "Loom House" },
      ])
      .returning();
    chairId = chair.id;
    rugId = rug.id;
  });

  async function draftV1() {
    const [revision] = await handle.db.insert(revisions).values({ projectId, number: 1 }).returning();
    const lines = await handle.db
      .insert(revisionLines)
      .values([
        { revisionId: revision.id, itemId: chairId, unitPriceCents: 80_000 },
        { revisionId: revision.id, itemId: rugId, unitPriceCents: 30_000, restockingFeeBps: 2000 },
      ])
      .returning();
    return { revision, lines };
  }

  it("lets a draft change freely", async () => {
    const { lines } = await draftV1();
    await handle.db.update(revisionLines).set({ unitPriceCents: 85_000 }).where(eq(revisionLines.id, lines[0].id));
    const [line] = await handle.db.select().from(revisionLines).where(eq(revisionLines.id, lines[0].id));
    expect(line.unitPriceCents).toBe(85_000);
  });

  it("freezes lines once the revision is sent", async () => {
    const { revision, lines } = await draftV1();
    await sendRevision(handle.db, revision.id);

    await expectRejected(handle.db.update(revisionLines).set({ unitPriceCents: 1 }).where(eq(revisionLines.id, lines[0].id)), /frozen/);
    await expectRejected(handle.db.delete(revisionLines).where(eq(revisionLines.id, lines[1].id)), /frozen/);
    const [desk] = await handle.db.insert(items).values({ projectId, name: "Light oak desk", vendor: "Hartwood" }).returning();
    await expectRejected(handle.db.insert(revisionLines).values({ revisionId: revision.id, itemId: desk.id, unitPriceCents: 110_000 }), /frozen/);
  });

  it("keeps a sent revision's content and lets its status only move forward", async () => {
    const { revision } = await draftV1();
    await sendRevision(handle.db, revision.id);

    await expectRejected(handle.db.update(revisions).set({ contentHash: "tampered" }).where(eq(revisions.id, revision.id)), /frozen/);
    await expectRejected(handle.db.delete(revisions).where(eq(revisions.id, revision.id)), /cannot be deleted/);
    await handle.db.update(revisions).set({ status: "approved" }).where(eq(revisions.id, revision.id));
    await expectRejected(handle.db.update(revisions).set({ status: "draft" }).where(eq(revisions.id, revision.id)), /cannot go from approved to draft/);
  });

  it("does not let a draft jump straight to approved", async () => {
    const { revision } = await draftV1();
    await expectRejected(handle.db.update(revisions).set({ status: "approved", contentHash: "x" }).where(eq(revisions.id, revision.id)), /cannot go from draft to approved/);
  });

  it("accepts an approval only for the exact content that was sent", async () => {
    const { revision, lines } = await draftV1();
    const hash = await sendRevision(handle.db, revision.id);
    const approval = { revisionId: revision.id, decision: "approved" as const, approverName: "Emma Park", signature: "Emma Park" };

    await expectRejected(handle.db.insert(approvals).values({ ...approval, revisionLineId: lines[0].id, contentHash: "not-the-hash" }), /does not match/);
    await handle.db.insert(approvals).values({ ...approval, revisionLineId: lines[0].id, contentHash: hash });
    await expectRejected(handle.db.insert(approvals).values({ ...approval, revisionLineId: lines[0].id, contentHash: hash }), /approvals_one_per_line/);
  });

  it("refuses approvals on drafts and on lines from another revision", async () => {
    const { revision, lines } = await draftV1();
    const approval = { decision: "approved" as const, approverName: "Emma Park", signature: "Emma Park", contentHash: "x" };
    await expectRejected(handle.db.insert(approvals).values({ ...approval, revisionId: revision.id, revisionLineId: lines[0].id }), /not waiting for approval/);

    const [other] = await handle.db.insert(revisions).values({ projectId, number: 2, basedOnRevisionId: revision.id }).returning();
    await expectRejected(handle.db.insert(approvals).values({ ...approval, revisionId: other.id, revisionLineId: lines[0].id }), /does not belong/);
  });

  it("never lets a V1 approval stand in for V2", async () => {
    const { revision: v1 } = await draftV1();
    const v1Hash = await sendRevision(handle.db, v1.id);
    await handle.db.update(revisions).set({ status: "approved" }).where(eq(revisions.id, v1.id));

    const [v2] = await handle.db.insert(revisions).values({ projectId, number: 2, basedOnRevisionId: v1.id }).returning();
    const [v2Rug] = await handle.db.insert(revisionLines).values({ revisionId: v2.id, itemId: rugId, unitPriceCents: 30_000 }).returning();
    const v2Hash = await sendRevision(handle.db, v2.id);
    expect(v2Hash).not.toBe(v1Hash);

    await expectRejected(
      handle.db.insert(approvals).values({
        revisionId: v2.id,
        revisionLineId: v2Rug.id,
        decision: "approved",
        approverName: "Emma Park",
        signature: "Emma Park",
        contentHash: v1Hash,
      }),
      /does not match/,
    );
  });

  it("keeps approvals as a permanent record", async () => {
    const { revision, lines } = await draftV1();
    const hash = await sendRevision(handle.db, revision.id);
    const [record] = await handle.db
      .insert(approvals)
      .values({ revisionId: revision.id, revisionLineId: lines[0].id, decision: "approved", approverName: "Emma Park", signature: "Emma Park", contentHash: hash })
      .returning();

    await expectRejected(handle.db.update(approvals).set({ decision: "declined" }).where(eq(approvals.id, record.id)), /cannot be changed/);
    await expectRejected(handle.db.delete(approvals).where(eq(approvals.id, record.id)), /cannot be changed/);
  });

  it("will not send an empty revision", async () => {
    const [empty] = await handle.db.insert(revisions).values({ projectId, number: 1 }).returning();
    await expect(sendRevision(handle.db, empty.id)).rejects.toThrow(/at least one quoted line/);
  });
});
