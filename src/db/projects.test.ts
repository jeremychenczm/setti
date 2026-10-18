import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "./schema";
import { openTestDb, testDatabaseUrl, truncate } from "./testing";

describe.skipIf(!testDatabaseUrl)("projects table", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;

  beforeAll(async () => {
    handle = await openTestDb();
  });
  beforeEach(() => truncate(handle.db, "projects"));
  afterAll(() => handle?.pool.end());

  it("stores a project and reads it back with defaults filled in", async () => {
    const [created] = await handle.db
      .insert(projects)
      .values({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park" })
      .returning();

    const [read] = await handle.db.select().from(projects).where(eq(projects.id, created.id));
    expect(read).toMatchObject({ name: "Maple Ave", space: "Window corner", clientName: "Emma Park", currency: "USD" });
    expect(read.createdAt).toBeInstanceOf(Date);
  });

  it("rejects a project without a client name", async () => {
    await expect(
      handle.db.insert(projects).values({ name: "Oak Street", space: "Living room" } as typeof projects.$inferInsert),
    ).rejects.toThrow();
  });
});
