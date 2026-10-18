import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { revisionLines, revisions } from "../db/schema";
import { hashRevision } from "./hash";

/**
 * Freezes a draft revision and sends it to the client. Returns the content hash
 * that every approval of this revision must carry.
 */
export async function sendRevision(db: Db, revisionId: string): Promise<string> {
  return db.transaction(async (tx) => {
    // Lock the revision so no line can be added between hashing and freezing.
    const [revision] = await tx.select().from(revisions).where(eq(revisions.id, revisionId)).for("update");
    if (!revision) throw new Error(`Revision ${revisionId} does not exist`);
    if (revision.status !== "draft") throw new Error(`Revision ${revisionId} is ${revision.status}, not a draft`);

    const lines = await tx.select().from(revisionLines).where(eq(revisionLines.revisionId, revisionId));
    if (lines.length === 0) throw new Error(`Revision ${revisionId} has no lines`);

    const contentHash = hashRevision(lines);
    await tx
      .update(revisions)
      .set({ status: "sent", contentHash, sentAt: new Date() })
      .where(and(eq(revisions.id, revisionId), eq(revisions.status, "draft")));
    return contentHash;
  });
}
