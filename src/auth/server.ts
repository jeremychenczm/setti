/**
 * Sign-up, sign-in and sessions, through Better Auth: email and password with
 * scrypt hashes, httpOnly cookies, origin checks and rate limits. A studio is
 * Better Auth's organization. A designer's sign-up creates their studio; a
 * client's account has none. Each sign-in works in the user's first studio.
 */
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { AUTH_COOKIE_PREFIX } from "./cookie-prefix";
import { authAccounts, authSessions, authVerifications, studioInvitations, studioMembers, studios, users } from "./schema";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface AuthOptions {
  baseURL?: string;
  secret?: string;
  /** Off in tests, which sign many accounts up in a row. */
  rateLimit?: boolean;
}

export function createAuth(db: Db, options: AuthOptions = {}) {
  const auth = betterAuth({
    appName: "Setti",
    baseURL: options.baseURL ?? process.env.BETTER_AUTH_URL ?? process.env.SETTI_PUBLIC_URL,
    secret: options.secret ?? process.env.BETTER_AUTH_SECRET,
    trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users, session: authSessions, account: authAccounts, verification: authVerifications,
        organization: studios, member: studioMembers, invitation: studioInvitations,
      },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: PASSWORD_MIN_LENGTH, maxPasswordLength: PASSWORD_MAX_LENGTH, autoSignIn: true },
    rateLimit: {
      enabled: options.rateLimit ?? process.env.NODE_ENV !== "test",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
      },
    },
    telemetry: { enabled: false },
    // UUIDs, like every other table, so a studio id can key the data it owns.
    advanced: { cookiePrefix: AUTH_COOKIE_PREFIX, database: { generateId: () => randomUUID() } },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [first] = await db.select({ studioId: studioMembers.organizationId }).from(studioMembers)
              .where(eq(studioMembers.userId, session.userId)).orderBy(asc(studioMembers.createdAt)).limit(1);
            return { data: { ...session, activeOrganizationId: first?.studioId ?? null } };
          },
        },
      },
    },
    plugins: [organization({ allowUserToCreateOrganization: true, creatorRole: "owner" }), nextCookies()],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
