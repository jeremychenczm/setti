"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import { authClient } from "@/auth/client";
import { useDismiss } from "../useDismiss";
import { Avatar } from "./primitives";
import { EndDemoButton } from "../try/EndDemoButton";

/** The demo's people a visitor can be: the designer and the Maple client. */
const DEMO_PEOPLE = DEMO_ACCOUNTS.filter((option) => option.id === "jordan" || option.id === "emma");
const ITEM = "block w-full rounded-lg px-2 py-2 text-left text-[12px] text-slate-600 hover:bg-[var(--canvas)]";

/**
 * The signed-in account and its menu. A demo visitor switches between the demo's
 * people here; a real account opens its settings or signs out. `compact` shows
 * only the avatar, for the chat header on screens without the sidebar.
 */
export function AccountMenu({ account, demo = false, onSwitch, compact = false, placement = "below" }: { account: DemoAccount; demo?: boolean; onSwitch: (id: AccountId) => void; compact?: boolean; placement?: "above" | "below" }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useDismiss(root, open, setOpen);

  async function signOut() {
    setSigningOut(true);
    try { await authClient.signOut(); router.push("/sign-in"); router.refresh(); }
    finally { setSigningOut(false); }
  }

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={demo ? `Signed in as ${account.name}. Switch person` : `Signed in as ${account.name}. Account menu`}
        className={compact ? "rounded-full ring-offset-2 hover:ring-2 hover:ring-brand-100" : "flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-white/70"}
      >
        <Avatar person={account} size={compact ? "lg" : "sm"} />
        {!compact && <>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12px] font-medium">{account.name}</span>
            <span className="block truncate text-[11px] text-[var(--muted)]">{account.title}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        </>}
      </button>
      {open && (
        <div role="menu" aria-label={demo ? "Switch person" : "Account"} className={`absolute z-30 w-64 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg ${compact && placement !== "above" ? "right-0 top-full mt-2" : "bottom-full left-0 mb-2"}`}>
          {demo ? <>
            <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">Switch person · demo</div>
            {DEMO_PEOPLE.map((option) => (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={option.id === account.id}
                onClick={() => { setOpen(false); if (option.id !== account.id) onSwitch(option.id); }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left ${option.id === account.id ? "bg-[var(--primary-soft)]" : "hover:bg-[var(--canvas)]"}`}
              >
                <Avatar person={option} size="sm" />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12px] font-medium">{option.name}</span>
                  <span className="block truncate text-[11px] text-[var(--muted)]">{option.title}</span>
                </span>
                {option.id === account.id && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />}
              </button>
            ))}
            <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-[var(--muted)]">This demo signs you in as each person in turn. Who you are decides who sends messages and what you can see.</p>
            <div className="mt-1 border-t border-[var(--line)] pt-1">
              <Link href="/" role="menuitem" className={ITEM}>Setti home</Link>
              <EndDemoButton menuItem className={ITEM} />
            </div>
          </> : <>
            <Link href="/account" role="menuitem" className={ITEM}>Account</Link>
            <button type="button" role="menuitem" disabled={signingOut} onClick={() => void signOut()} className={ITEM}>{signingOut ? "Signing out…" : "Sign out"}</button>
          </>}
        </div>
      )}
    </div>
  );
}
