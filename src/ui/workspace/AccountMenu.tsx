"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useRef, useState } from "react";
import { DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import { useDismiss } from "../useDismiss";
import { Avatar } from "./primitives";

/**
 * The signed-in demo account and the menu that switches it. `compact` shows only
 * the avatar, for the chat header on screens without the sidebar.
 */
export function AccountMenu({ account, onSwitch, compact = false }: { account: DemoAccount; onSwitch: (id: AccountId) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, open, setOpen);

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${account.name}. Switch account`}
        className={compact ? "rounded-full ring-offset-2 hover:ring-2 hover:ring-blue-100" : "flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-white/70"}
      >
        <Avatar person={account} size="sm" />
        {!compact && <>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12px] font-medium">{account.name}</span>
            <span className="block truncate text-[11px] text-[var(--muted)]">{account.title}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
        </>}
      </button>
      {open && (
        <div role="menu" aria-label="Switch account" className={`absolute z-30 w-64 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg ${compact ? "right-0 top-full mt-2" : "bottom-full left-0 mb-2"}`}>
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">Switch account · demo</div>
          {DEMO_ACCOUNTS.map((option) => (
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
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-[var(--muted)]">No login in this demo. The account decides who sends messages and what you can see.</p>
        </div>
      )}
    </div>
  );
}
