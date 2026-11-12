import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessions } from "@/auth/schema";
import { createAuth, type Auth } from "@/auth/server";
import { openTestDb, testDatabaseUrl, truncate } from "@/db/testing";
import { ensureDemoPeople, signInDemoPerson } from "./people";

/** The session id a sign-in response's cookie belongs to. */
async function sessionId(auth: Auth, response: Response): Promise<string> {
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return (await auth.api.getSession({ headers: new Headers({ cookie }) }))!.session.id;
}

describe.skipIf(!testDatabaseUrl)("switching between the demo's people", () => {
  let handle: Awaited<ReturnType<typeof openTestDb>>;
  let auth: Auth;
  beforeAll(async () => {
    handle = await openTestDb();
    await truncate(handle.db, "users", "studios");
    auth = createAuth(handle.db, { baseURL: "http://localhost:3000", secret: "test-only-secret-0123456789abcdefghijklmnop", rateLimit: false, signUpEmailDomains: null });
  });
  afterAll(async () => { await handle.pool.end(); });

  // A request sent before a switch comes back for the replaced session; were it deleted, its reply would clear the new cookie.
  it("keeps the replaced session valid and ends the ones before it", async () => {
    const people = await ensureDemoPeople(handle.db, auth, randomUUID());
    const first = await sessionId(auth, await signInDemoPerson(handle.db, auth, people.jordan));
    const second = await sessionId(auth, await signInDemoPerson(handle.db, auth, people.emma, first));
    const third = await sessionId(auth, await signInDemoPerson(handle.db, auth, people.jordan, second));
    const left = await handle.db.select({ id: authSessions.id }).from(authSessions).where(inArray(authSessions.userId, [people.jordan.userId, people.emma.userId]));
    expect(left.map((row) => row.id).sort()).toEqual([second, third].sort());
  });
});
