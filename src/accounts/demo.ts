/**
 * Demo accounts. Setti has no login: the account picked in the sidebar is kept in
 * a cookie, and every page and API reads the same cookie. It tells the app who is
 * acting, not who the visitor really is, so it is a demo identity, not
 * authentication.
 */
import type { CaseKey } from "@/chat/types";

export type AccountId = "jordan" | "sofia" | "emma";
export type AccountRole = "designer" | "client";

export interface DemoAccount {
  id: AccountId;
  name: string;
  role: AccountRole;
  /** What the account menu shows under the name. */
  title: string;
  /** A client sees only this project; the designer sees every project. */
  projectKey: CaseKey | null;
  avatar: string;
}

export const ACCOUNT_COOKIE = "setti-demo-account";

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { id: "jordan", name: "Jordan Lee", role: "designer", title: "Designer · Lee Studio", projectKey: null, avatar: "/avatars/designer.webp" },
  { id: "sofia", name: "Sofia Martinez", role: "client", title: "Client · Willow Residence", projectKey: "willow", avatar: "/avatars/client.webp" },
  { id: "emma", name: "Emma Park", role: "client", title: "Client · Maple Ave", projectKey: "maple", avatar: "/avatars/budget-manager.webp" },
];

const DEFAULT_ACCOUNT = DEMO_ACCOUNTS[0];

/** The account a cookie names, or null when it names none. */
export function findAccount(value: string | null | undefined): DemoAccount | null {
  return DEMO_ACCOUNTS.find((account) => account.id === value) ?? null;
}

/** The account a cookie names; a visitor who never switched is the designer. */
export function accountOrDefault(value: string | null | undefined): DemoAccount {
  return findAccount(value) ?? DEFAULT_ACCOUNT;
}

export function canOpenProject(account: DemoAccount, key: CaseKey): boolean {
  return account.projectKey === null || account.projectKey === key;
}

/** The client account of a project. */
export function clientOf(key: CaseKey): DemoAccount {
  return DEMO_ACCOUNTS.find((account) => account.projectKey === key)!;
}

/** Sets the cookie in the browser. A year, so a demo visitor stays who they picked. */
export function rememberAccount(id: AccountId): void {
  document.cookie = `${ACCOUNT_COOKIE}=${id}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=strict`;
}
