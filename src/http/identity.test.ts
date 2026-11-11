import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultStudioName, newStudioSlug } from "@/auth/names";
import { users } from "@/auth/schema";
import { createAuth, type Auth } from "@/auth/server";
import { chatCases, projectClients } from "@/chat/schema";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { actorFrom, homeOf, projectAccess, scopeOf } from "./identity";

const PASSWORD = "correct horse battery";
/** The `name=value` pairs a response sets, as a request's Cookie header. */
const cookiesFrom = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");

describe.skipIf(!testDatabaseUrl)("who a request is", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let auth: Auth;
  const actorOf = (cookie: string) => actorFrom(auth, handle.db, new Headers({ cookie }));
  const signUp = async (email: string, name: string) => cookiesFrom(await auth.api.signUpEmail({ body: { name, email, password: PASSWORD }, asResponse: true }));
  /** A designer's account and the studio they run; returns the cookie and the studio id. */
  async function designer(email: string, name: string) {
    const cookie = await signUp(email, name);
    const studio = await auth.api.createOrganization({ body: { name: defaultStudioName(name), slug: newStudioSlug() }, headers: new Headers({ cookie }) });
    return { cookie, studioId: studio!.id };
  }
  /** Adds the account with this email as the client of `key` in a studio. */
  async function addClient(email: string, studioId: string, key: "maple" | "willow") {
    await handle.db.insert(chatCases).values({ sessionId: studioId, projectKey: key }).onConflictDoNothing();
    const [project] = await handle.db.select({ id: chatCases.id }).from(chatCases).where(and(eq(chatCases.sessionId, studioId), eq(chatCases.projectKey, key)));
    const [user] = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await handle.db.insert(projectClients).values({ caseId: project.id, userId: user.id });
  }

  beforeAll(async () => {
    handle = await openTestDb();
    auth = createAuth(handle.db, { baseURL: "http://localhost:3000", secret: "test-only-secret-0123456789abcdefghijklmnop", rateLimit: false });
  });
  beforeEach(async () => { await truncate(handle.db, "users", "studios", "chat_cases"); });
  afterAll(async () => { await handle.pool.end(); });

  it("is no one without a session, or with a forged one", async () => {
    expect(await actorOf("")).toBeNull();
    expect(await actorOf("setti.session_token=forged.token")).toBeNull();
  });

  it("knows a designer by their studio, and opens its projects there", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const actor = (await actorOf(jordan.cookie))!;
    expect(actor).toMatchObject({ role: "designer", demoPersona: null, studio: { id: jordan.studioId, kind: "real", role: "owner" }, projects: [] });
    expect(scopeOf(actor, "maple")).toEqual({ sessionId: jordan.studioId, account: expect.objectContaining({ id: actor.userId, role: "designer", name: "Jordan Lee" }) });
    expect(homeOf(actor).sessionId).toBe(jordan.studioId);
  });

  it("opens a client's own project only, in the studio that owns it", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const emma = await signUp("emma@example.com", "Emma Park");
    await addClient("emma@example.com", jordan.studioId, "maple");
    const actor = (await actorOf(emma))!;
    expect(actor).toMatchObject({ role: "client", studio: null, projects: [{ studioId: jordan.studioId, key: "maple" }] });
    expect(scopeOf(actor, "maple")).toEqual({ sessionId: jordan.studioId, account: expect.objectContaining({ role: "client", projectKey: "maple", name: "Emma Park" }) });
    expect(scopeOf(actor, "willow")).toBeNull();
    expect(projectAccess(actor, { studioId: jordan.studioId, key: "maple" })).toMatchObject({ role: "client" });
    expect(projectAccess(actor, { studioId: jordan.studioId, key: "willow" })).toBeNull();
  });

  it("keeps studios apart: no one opens another studio's project", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const avery = await designer("avery@example.com", "Avery Stone");
    const emma = await signUp("emma@example.com", "Emma Park");
    await addClient("emma@example.com", jordan.studioId, "maple");
    const averyActor = (await actorOf(avery.cookie))!;
    expect(projectAccess(averyActor, { studioId: jordan.studioId, key: "maple" })).toBeNull();
    expect(scopeOf(averyActor, "maple")?.sessionId).toBe(avery.studioId);
    expect(projectAccess((await actorOf(emma))!, { studioId: avery.studioId, key: "maple" })).toBeNull();
  });

  it("gives a client without a project nothing to read", async () => {
    const actor = (await actorOf(await signUp("new@example.com", "New Client")))!;
    expect(actor).toMatchObject({ role: "client", projects: [] });
    expect(homeOf(actor)).toEqual({ sessionId: null, account: expect.objectContaining({ role: "client", projectKey: null }) });
    expect(scopeOf(actor, "maple")).toBeNull();
  });

  it("reads a client's newest project first", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const avery = await designer("avery@example.com", "Avery Stone");
    const emma = await signUp("emma@example.com", "Emma Park");
    await addClient("emma@example.com", jordan.studioId, "willow");
    await addClient("emma@example.com", avery.studioId, "maple");
    const actor = (await actorOf(emma))!;
    expect(actor.projects.map((project) => [project.studioId, project.key])).toEqual([[avery.studioId, "maple"], [jordan.studioId, "willow"]]);
    expect(homeOf(actor).sessionId).toBe(avery.studioId);
  });
});
