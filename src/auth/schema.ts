/**
 * Accounts and studios, in the shape Better Auth expects (generated with
 * `npx auth@1.7.20 generate`, then renamed, with UUID ids like every other table): a studio is Better Auth's
 * "organization", a studio member its "member". The adapter maps each model to
 * these tables in `src/auth/server.ts`.
 */
import { relations, sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true });

/** The two people of the guided demo: Jordan the designer and Emma the client. */
export type DemoPersona = "jordan" | "emma";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  /**
   * Set only on a throwaway account made for a visitor trying Setti: which demo
   * person it plays (the designer or the client). It signs in through the demo,
   * never with a password a person knows. Null on every real account.
   */
  demoPersona: text("demo_persona").$type<DemoPersona>(),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [check("users_demo_persona_valid", sql`${t.demoPersona} IS NULL OR ${t.demoPersona} IN ('jordan', 'emma')`)]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The studio this sign-in works in. */
  activeOrganizationId: uuid("active_organization_id"),
}, (t) => [index("auth_sessions_user_idx").on(t.userId)]);

/** How a user signs in; for email and password, `password` holds the scrypt hash. */
export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: at("access_token_expires_at"),
  refreshTokenExpiresAt: at("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").$onUpdate(() => new Date()).notNull(),
}, (t) => [index("auth_accounts_user_idx").on(t.userId)]);

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]);

/** A designer's business. Its projects, clients and money belong to it. */
export const studios = pgTable("studios", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  /** real, or demo: a visitor's practice studio, with its limits and its clean-up. */
  kind: text("kind").$type<"real" | "demo">().default("real").notNull(),
  createdAt: at("created_at").notNull(),
  metadata: text("metadata"),
}, (t) => [check("studios_kind_valid", sql`${t.kind} IN ('real', 'demo')`)]);

export const studioMembers = pgTable("studio_members", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** owner, admin or member */
  role: text("role").default("member").notNull(),
  createdAt: at("created_at").notNull(),
}, (t) => [
  index("studio_members_studio_idx").on(t.organizationId), index("studio_members_user_idx").on(t.userId),
  unique("studio_members_one_per_user").on(t.organizationId, t.userId),
]);

export const studioInvitations = pgTable("studio_invitations", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").defaultNow().notNull(),
  inviterId: uuid("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (t) => [index("studio_invitations_studio_idx").on(t.organizationId), index("studio_invitations_email_idx").on(t.email)]);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(authSessions),
  accounts: many(authAccounts),
  members: many(studioMembers),
  invitations: many(studioInvitations),
}));
export const authSessionsRelations = relations(authSessions, ({ one }) => ({ user: one(users, { fields: [authSessions.userId], references: [users.id] }) }));
export const authAccountsRelations = relations(authAccounts, ({ one }) => ({ user: one(users, { fields: [authAccounts.userId], references: [users.id] }) }));
export const studiosRelations = relations(studios, ({ many }) => ({ members: many(studioMembers), invitations: many(studioInvitations) }));
export const studioMembersRelations = relations(studioMembers, ({ one }) => ({
  organization: one(studios, { fields: [studioMembers.organizationId], references: [studios.id] }),
  user: one(users, { fields: [studioMembers.userId], references: [users.id] }),
}));
export const studioInvitationsRelations = relations(studioInvitations, ({ one }) => ({
  organization: one(studios, { fields: [studioInvitations.organizationId], references: [studios.id] }),
  user: one(users, { fields: [studioInvitations.inviterId], references: [users.id] }),
}));
