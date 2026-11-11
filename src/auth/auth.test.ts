import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { authAccounts, authSessions, studioMembers, studios, users } from "./schema";
import { createAuth, PASSWORD_MIN_LENGTH, type Auth } from "./server";
import { activeStudio } from "./studio";

const PASSWORD = "correct horse battery";

/** The `name=value` pairs a response sets, as a request's Cookie header. */
function cookiesFrom(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

describe.skipIf(!testDatabaseUrl)("accounts and studios", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let auth: Auth;
  const signUp = (email: string, password = PASSWORD, name = "Jordan Lee") =>
    auth.api.signUpEmail({ body: { name, email, password }, asResponse: true });
  const signIn = (email: string, password: string) =>
    auth.api.signInEmail({ body: { email, password }, asResponse: true });

  beforeAll(async () => {
    handle = await openTestDb();
    auth = createAuth(handle.db, { baseURL: "http://localhost:3000", secret: "test-only-secret-0123456789abcdefghijklmnop", rateLimit: false });
  });
  beforeEach(async () => { await truncate(handle.db, "users", "studios"); });
  afterAll(async () => { await handle.pool.end(); });

  it("gives a new account a studio it owns, and signs it in to that studio", async () => {
    const response = await signUp("jordan@example.com");
    expect(response.status).toBe(200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesFrom(response) }) });
    expect(session?.user.email).toBe("jordan@example.com");

    const [studio] = await handle.db.select().from(studios);
    expect(studio.name).toBe("Jordan Lee's studio");
    expect(await activeStudio(handle.db, session!.session)).toEqual({ id: studio.id, name: "Jordan Lee's studio", role: "owner" });
    const [saved] = await handle.db.select().from(authSessions).where(eq(authSessions.id, session!.session.id));
    expect(saved.activeOrganizationId).toBe(studio.id);
    const members = await handle.db.select().from(studioMembers);
    expect(members).toEqual([expect.objectContaining({ organizationId: studio.id, userId: session!.user.id, role: "owner" })]);
  });

  it("refuses a second account with the same email", async () => {
    expect((await signUp("jordan@example.com")).status).toBe(200);
    expect((await signUp("jordan@example.com")).status).toBeGreaterThanOrEqual(400);
    expect(await handle.db.select().from(users)).toHaveLength(1);
    expect(await handle.db.select().from(studios)).toHaveLength(1);
  });

  it(`refuses a password shorter than ${PASSWORD_MIN_LENGTH} characters`, async () => {
    expect((await signUp("short@example.com", "a".repeat(PASSWORD_MIN_LENGTH - 1))).status).toBe(400);
    expect(await handle.db.select().from(users)).toHaveLength(0);
  });

  it("stores a password hash, never the password", async () => {
    await signUp("jordan@example.com");
    const [account] = await handle.db.select().from(authAccounts);
    expect(account.providerId).toBe("credential");
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(PASSWORD);
  });

  it("signs in with the right password only, into the account's own studio", async () => {
    await signUp("jordan@example.com");
    expect((await signIn("jordan@example.com", "wrong password here")).status).toBe(401);
    const response = await signIn("jordan@example.com", PASSWORD);
    expect(response.status).toBe(200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesFrom(response) }) });
    const [member] = await handle.db.select().from(studioMembers).where(eq(studioMembers.userId, session!.user.id));
    expect(session?.session.activeOrganizationId).toBe(member.organizationId);
  });

  it("never works in a studio the user is not a member of", async () => {
    const jordan = await auth.api.getSession({ headers: new Headers({ cookie: cookiesFrom(await signUp("jordan@example.com", PASSWORD, "Jordan Lee")) }) });
    await signUp("avery@example.com", PASSWORD, "Avery Stone");
    const [avery] = await handle.db.select({ id: studios.id }).from(studios).where(eq(studios.name, "Avery Stone's studio"));
    const studio = await activeStudio(handle.db, { ...jordan!.session, activeOrganizationId: avery.id });
    expect(studio?.name).toBe("Jordan Lee's studio");
  });

  it("ends the session on sign-out", async () => {
    const cookie = cookiesFrom(await signUp("jordan@example.com"));
    await auth.api.signOut({ headers: new Headers({ cookie }) });
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });

  it("keeps two accounts in two separate studios", async () => {
    await signUp("jordan@example.com", PASSWORD, "Jordan Lee");
    await signUp("avery@example.com", PASSWORD, "Avery Stone");
    const rows = await handle.db.select({ studio: studios.name, role: studioMembers.role, email: users.email }).from(studioMembers)
      .innerJoin(studios, eq(studios.id, studioMembers.organizationId)).innerJoin(users, eq(users.id, studioMembers.userId));
    expect(rows.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { studio: "Avery Stone's studio", role: "owner", email: "avery@example.com" },
      { studio: "Jordan Lee's studio", role: "owner", email: "jordan@example.com" },
    ]);
  });
});
