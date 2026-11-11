"use client";
/**
 * Switches a demo visitor to another person of their demo (the designer or the
 * client). The server signs the browser in as that person; the page then loads
 * fresh at `next`, so everything on it is read as the new person.
 */
import type { AccountId } from "@/accounts/demo";

/** Resolves to the reason the switch failed; on success the browser is already leaving the page. */
export async function switchPersona(persona: AccountId, next = `${window.location.pathname}${window.location.search}${window.location.hash}`): Promise<string | null> {
  try {
    const response = await fetch("/api/demo/persona", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona, next }),
    });
    const body = await response.json().catch(() => null) as { next?: string; error?: string } | null;
    if (!response.ok || !body?.next) return body?.error ?? "The demo could not switch people. Try again.";
    const target = new URL(body.next, window.location.origin);
    // The same page reloads, so it is read again as the new person.
    if (target.pathname === window.location.pathname && target.search === window.location.search) {
      window.history.replaceState(window.history.state, "", `${target.pathname}${target.search}${target.hash}`);
      window.location.reload();
    } else window.location.assign(body.next);
    return null;
  } catch {
    return "The demo could not switch people. Check the connection and try again.";
  }
}
