import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users, type DemoPersona } from "@/auth/schema";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { AI_REQUESTS_PER_ACCOUNT, takeAiAllowance } from "./allowance";
import { aiAllowances } from "./schema";

describe.skipIf(!testDatabaseUrl)("AI allowance", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "users"); });
  afterAll(async () => { await handle.pool.end(); });

  async function account(demoPersona: DemoPersona | null = null) {
    const userId = randomUUID(), now = new Date();
    await handle.db.insert(users).values({ id: userId, name: "Avery Stone", email: `${userId}@gmail.com`, emailVerified: false, demoPersona, createdAt: now, updatedAt: now });
    return { userId, demoPersona };
  }

  it(`gives a real account ${AI_REQUESTS_PER_ACCOUNT} AI requests in all, even when they arrive at once`, async () => {
    const avery = await account(), mia = await account();
    const results = await Promise.all(Array.from({ length: AI_REQUESTS_PER_ACCOUNT + 5 }, () => takeAiAllowance(handle.db, avery)));
    expect(results.filter(Boolean)).toHaveLength(AI_REQUESTS_PER_ACCOUNT);
    expect(await takeAiAllowance(handle.db, avery)).toBe(false);
    expect(await takeAiAllowance(handle.db, mia)).toBe(true);
  });

  it("leaves the demo's visitors to the hourly budget", async () => {
    const visitor = await account("jordan");
    for (let i = 0; i <= AI_REQUESTS_PER_ACCOUNT; i++) expect(await takeAiAllowance(handle.db, visitor)).toBe(true);
    expect(await handle.db.select().from(aiAllowances)).toHaveLength(0);
  });
});
