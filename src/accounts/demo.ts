/**
 * The people of the demo, and the shape every page and store takes for "who is
 * acting". A demo visitor is signed in as Jordan or Emma, and the stores see that
 * demo person; a real account is shown in the same shape (see `accountOf`).
 */
import type { CaseKey } from "@/chat/types";

export type AccountId = "jordan" | "sofia" | "emma";
export type AccountRole = "designer" | "client";

export interface DemoAccount {
  /** A demo person's id, or a real account's user id. */
  id: string;
  name: string;
  role: AccountRole;
  /** What the account menu shows under the name. */
  title: string;
  /** A client sees only this project; the designer sees every project. */
  projectKey: CaseKey | null;
  avatar: string;
}

export const DEMO_ACCOUNTS: readonly (DemoAccount & { id: AccountId })[] = [
  { id: "jordan", name: "Jordan Lee", role: "designer", title: "Designer · Lee Studio", projectKey: null, avatar: "/avatars/designer.webp" },
  { id: "sofia", name: "Sofia Martinez", role: "client", title: "Client · Willow Residence", projectKey: "willow", avatar: "/avatars/client.webp" },
  { id: "emma", name: "Emma Park", role: "client", title: "Client · Maple Ave Café", projectKey: "maple", avatar: "/avatars/budget-manager.webp" },
];

/** The demo person with this id, or null. */
export function findAccount(value: string | null | undefined): DemoAccount | null {
  return DEMO_ACCOUNTS.find((account) => account.id === value) ?? null;
}

export function canOpenProject(account: DemoAccount, key: CaseKey): boolean {
  return account.role === "designer" || account.projectKey === key;
}

/** The client account of a project. */
export function clientOf(key: CaseKey): DemoAccount {
  return DEMO_ACCOUNTS.find((account) => account.projectKey === key)!;
}
