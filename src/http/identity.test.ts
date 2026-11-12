import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultStudioName, newStudioSlug } from "@/auth/names";
import { users } from "@/auth/schema";
import { createAuth, type Auth } from "@/auth/server";
import { chatCases, projectClients, projectInvites } from "@/chat/schema";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { actorFrom, homeOf, projectAccess, scopeOf } from "./identity";
import { sampleProject } from "@/demo/sample-projects";
import { createProject } from "@/projects/create";
import { acceptInvite, createInvite, InviteError, readInvite } from "@/projects/invite";
import { insertProject } from "@/projects/store";
import { TEST_KEY, testProject } from "@/projects/testing";
import { projectsFor } from "@/projects/summary";

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
  /** Adds the account as the client of `key`, a sample or the test project unless the studio already has it. */
  async function addClient(email: string, studioId: string, key: string) {
    const sample = key === TEST_KEY ? testProject : sampleProject(key);
    if (sample) await insertProject(handle.db, studioId, key, sample);
    const [project] = await handle.db.select({ id: chatCases.id }).from(chatCases).where(and(eq(chatCases.sessionId, studioId), eq(chatCases.projectKey, key)));
    const [user] = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await handle.db.insert(projectClients).values({ caseId: project.id, userId: user.id });
  }

  beforeAll(async () => {
    handle = await openTestDb();
    auth = createAuth(handle.db, { baseURL: "http://localhost:3000", secret: "test-only-secret-0123456789abcdefghijklmnop", rateLimit: false, signUpEmailDomains: null });
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
    expect(scopeOf(actor, TEST_KEY)).toBeNull();
    expect(projectAccess(actor, { studioId: jordan.studioId, key: "maple" })).toMatchObject({ role: "client" });
    expect(projectAccess(actor, { studioId: jordan.studioId, key: TEST_KEY })).toBeNull();
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
    await addClient("emma@example.com", jordan.studioId, TEST_KEY);
    await addClient("emma@example.com", avery.studioId, "maple");
    const actor = (await actorOf(emma))!;
    expect(actor.projects.map((project) => [project.studioId, project.key])).toEqual([[avery.studioId, "maple"], [jordan.studioId, TEST_KEY]]);
    expect(homeOf(actor).sessionId).toBe(avery.studioId);
  });

  it("lists a designer only their studio's projects, and a client only the ones they were added to", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const avery = await designer("avery@example.com", "Avery Stone");
    const emma = await signUp("emma@example.com", "Emma Park");
    const kitchen = await createProject(handle.db, jordan.studioId, "Jordan Lee", { name: "Kitchen remodel", subtitle: "Kitchen and dining" });
    const again = await createProject(handle.db, jordan.studioId, "Jordan Lee", { name: "Kitchen  Remodel!", subtitle: "" });
    await createProject(handle.db, avery.studioId, "Avery Stone", { name: "Kitchen remodel", subtitle: "" });
    expect([kitchen, again]).toEqual(["kitchen-remodel", "kitchen-remodel-2"]);
    await addClient("emma@example.com", jordan.studioId, "kitchen-remodel");

    const ofJordan = await projectsFor(handle.db, (await actorOf(jordan.cookie))!);
    expect(ofJordan.map((project) => [project.key, project.name, project.client?.name ?? null])).toEqual([
      ["kitchen-remodel", "Kitchen remodel", "Emma Park"], ["kitchen-remodel-2", "Kitchen  Remodel!", null],
    ]);
    expect(ofJordan[0]).toMatchObject({ subtitle: "Kitchen and dining", designer: { name: "Jordan Lee" }, quote: { lines: [] } });
    expect((await projectsFor(handle.db, (await actorOf(avery.cookie))!)).map((project) => project.key)).toEqual(["kitchen-remodel"]);
    const ofEmma = await projectsFor(handle.db, (await actorOf(emma))!);
    expect(ofEmma.map((project) => [project.key, project.designer.name])).toEqual([["kitchen-remodel", "Jordan Lee"]]);
  });

  it("brings a client in through a link that works once, expires, and is replaced by a newer one", async () => {
    const jordan = await designer("jordan@example.com", "Jordan Lee");
    const avery = await designer("avery@example.com", "Avery Stone");
    const jordanActor = (await actorOf(jordan.cookie))!;
    await createProject(handle.db, jordan.studioId, "Jordan Lee", { name: "Harbor loft", subtitle: "" });
    await createProject(handle.db, jordan.studioId, "Jordan Lee", { name: "Pier house", subtitle: "" });
    const now = new Date("2026-11-11T12:00:00Z");
    const refusal = (work: Promise<unknown>) => work.then(() => "accepted", (error: unknown) => error instanceof InviteError ? error.code : error);

    // Only the project's own studio makes its link, and a new link turns off the earlier one.
    expect(await refusal(createInvite(handle.db, avery.studioId, "harbor-loft", jordanActor.userId, now))).toBe("NOT_FOUND");
    const first = await createInvite(handle.db, jordan.studioId, "harbor-loft", jordanActor.userId, now);
    const second = await createInvite(handle.db, jordan.studioId, "harbor-loft", jordanActor.userId, now);
    expect(second.expiresAt).toEqual(new Date("2026-11-18T12:00:00Z"));
    expect(await readInvite(handle.db, first.token, now)).toMatchObject({ status: "replaced" });
    expect(await readInvite(handle.db, second.token, now)).toMatchObject({ status: "open", projectName: "Harbor loft", studioName: defaultStudioName("Jordan Lee"), designerName: "Jordan Lee" });
    expect(await readInvite(handle.db, "a-link-that-was-never-made", now)).toBeNull();
    const stored = (await handle.db.select({ tokenHash: projectInvites.tokenHash }).from(projectInvites)).map((row) => row.tokenHash);
    expect(stored).toHaveLength(2);
    expect(stored).not.toContain(second.token);

    const emma = await signUp("emma@example.com", "Emma Park");
    const emmaActor = (await actorOf(emma))!;
    expect(await refusal(acceptInvite(handle.db, first.token, emmaActor, now))).toBe("REPLACED");
    expect(await refusal(acceptInvite(handle.db, second.token, jordanActor, now))).toBe("STUDIO_ACCOUNT");
    expect(await refusal(acceptInvite(handle.db, second.token, emmaActor, second.expiresAt))).toBe("EXPIRED");
    expect(await acceptInvite(handle.db, second.token, emmaActor, now)).toEqual({ studioId: jordan.studioId, key: "harbor-loft" });

    // Once in, she opens this project only; the link is spent and the project needs no other.
    const joined = (await actorOf(emma))!;
    expect(joined.projects.map((project) => project.key)).toEqual(["harbor-loft"]);
    expect(scopeOf(joined, "pier-house")).toBeNull();
    const noah = await signUp("noah@example.com", "Noah Kim");
    expect(await refusal(acceptInvite(handle.db, second.token, (await actorOf(noah))!, now))).toBe("USED");
    expect(await refusal(createInvite(handle.db, jordan.studioId, "harbor-loft", jordanActor.userId, now))).toBe("HAS_CLIENT");
    const [loft] = await projectsFor(handle.db, jordanActor);
    expect(loft).toMatchObject({ key: "harbor-loft", client: { name: "Emma Park" }, clientJoined: true });
  });
});
