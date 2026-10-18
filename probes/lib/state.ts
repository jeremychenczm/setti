/**
 * Local, uncommitted state shared between probes: standing authorizations
 * created by P1/P7 and the vault token from P6. Lives in probes/.state.json,
 * which is gitignored.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "probes/.state.json";

export interface StandingAuthorization {
  label: string;
  orderId: string;
  authorizationId: string;
  amountCents: number;
  createdAt: string;
  expiresAt?: string;
  source: "checkout" | "vault";
  /** Set once a probe has used or closed it, so it is not reused by mistake. */
  usedBy?: string;
  reauthorizedId?: string;
}

export interface ProbeState {
  authorizations: StandingAuthorization[];
  vaultTokenId?: string;
}

export function loadState(): ProbeState {
  if (!existsSync(FILE)) return { authorizations: [] };
  return JSON.parse(readFileSync(FILE, "utf8")) as ProbeState;
}

export function saveState(state: ProbeState): void {
  writeFileSync(FILE, JSON.stringify(state, null, 2) + "\n");
}

export function findAuthorization(state: ProbeState, label: string): StandingAuthorization {
  const auth = state.authorizations.find((a) => a.label === label);
  if (!auth) {
    const known = state.authorizations.map((a) => a.label).join(", ") || "none";
    throw new Error(`No standing authorization labelled "${label}" (known: ${known}). Create one with P1 first.`);
  }
  return auth;
}

export function ageInDays(auth: StandingAuthorization, now = new Date()): number {
  return (now.getTime() - new Date(auth.createdAt).getTime()) / (24 * 60 * 60 * 1000);
}
