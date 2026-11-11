/**
 * Accounts and studios, in the shape Better Auth expects (generated with
 * `npx auth@1.7.20 generate`, then renamed): a studio is Better Auth's
 * "organization", a studio member its "member". The adapter maps each model to
 * these tables in `src/auth/server.ts`.
 */
import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").$onUpdate(() => new Date()).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The studio this sign-in works in. */
  activeOrganizationId: text("active_organization_id"),
}, (t) => [index("auth_sessions_user_idx").on(t.userId)]);

/** How a user signs in; for email and password, `password` holds the scrypt hash. */
export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").defaultNow().notNull(),
  updatedAt: at("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]);

/** A designer's business. Its projects, clients and money belong to it. */
export const studios = pgTable("studios", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: at("created_at").notNull(),
  metadata: text("metadata"),
});

export const studioMembers = pgTable("studio_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** owner, admin or member */
  role: text("role").default("member").notNull(),
  createdAt: at("created_at").notNull(),
}, (t) => [
  index("studio_members_studio_idx").on(t.organizationId), index("studio_members_user_idx").on(t.userId),
  unique("studio_members_one_per_user").on(t.organizationId, t.userId),
]);

export const studioInvitations = pgTable("studio_invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => studios.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").default("pending").notNull(),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").defaultNow().notNull(),
  inviterId: text("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
