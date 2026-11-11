import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DemoAccount } from "@/accounts/demo";
import { studios } from "@/auth/schema";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { moneyDesk } from "@/money-desk/desk";
import { exampleProjects } from "@/money-desk/examples";
import { createProject, DEMO_PROJECTS_MAX, demoStudioFull } from "./create";

const designer: DemoAccount = { id: "designer", name: "Avery Stone", role: "designer", title: "Designer", projectKey: null };

describe.skipIf(!testDatabaseUrl)("what only a demo studio has", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  const studio = async (kind: "real" | "demo") => {
    const id = randomUUID();
    await handle.db.insert(studios).values({ id, name: `${kind} studio`, slug: `s-${id}`, kind, createdAt: new Date() });
    return id;
  };

  beforeAll(async () => { handle = await openTestDb(); });
  beforeEach(async () => { await truncate(handle.db, "studios", "chat_cases"); });
  afterAll(async () => { await handle.pool.end(); });

  it("keeps the prepared examples and a project limit to demo studios", async () => {
    const real = await studio("real"), demo = await studio("demo");
    expect((await moneyDesk(handle.db, real, designer)).projects).toEqual([]);
    expect((await moneyDesk(handle.db, demo, designer)).projects.map((project) => project.id)).toEqual(exampleProjects().map((project) => project.id));

    for (let n = 1; n < DEMO_PROJECTS_MAX; n++) await createProject(handle.db, demo, "Avery Stone", { name: `Project ${n}`, subtitle: "" });
    expect(await demoStudioFull(handle.db, demo)).toBe(false);
    await createProject(handle.db, demo, "Avery Stone", { name: "One more", subtitle: "" });
    expect(await demoStudioFull(handle.db, demo)).toBe(true);
  });
});
