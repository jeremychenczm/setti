import { FileSpreadsheet, FolderOpen, Inbox, MessageCircle, Wallet } from "lucide-react";
import type { ComponentType } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import { BrandMark } from "../BrandMark";
import { AccountMenu } from "./AccountMenu";

export type View = "projects" | "chats" | "quotes" | "inbox" | "money";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** The designer sends quotes and keeps the money desk; a client receives quotes as proposals. Projects lists the demo's prepared projects. */
function itemsFor(account: DemoAccount, demo: boolean): NavItem[] {
  return [
    { view: "inbox", label: "Inbox", icon: Inbox },
    { view: "chats", label: "Chats", icon: MessageCircle },
    ...(account.role === "designer" && demo ? [{ view: "projects" as const, label: "Projects", icon: FolderOpen }] : []),
    ...(account.role === "designer" ? [{ view: "money" as const, label: "Money", icon: Wallet }] : []),
    { view: "quotes", label: account.role === "designer" ? "Quotes" : "Proposals", icon: FileSpreadsheet },
  ];
}

/**
 * The sidebar at the left edge: modules on top, the account at the bottom. On a
 * wide screen each module is an icon with its name beside it; on a narrow one
 * it folds to an icon rail, as in a messaging app.
 */
export function Sidebar({ view, onView, account, demo, onSwitchAccount, badges = {} }: { view: View; onView: (v: View) => void; account: DemoAccount; demo: boolean; onSwitchAccount: (id: AccountId) => void; badges?: Partial<Record<View, number>> }) {
  return (
    <aside aria-label="Workspace sidebar" className={`flex w-[64px] shrink-0 flex-col items-center rounded-xl bg-[var(--rail)] py-3 ${view === "chats" ? "lg:rounded-r-none" : ""} lg:w-[184px] lg:items-stretch lg:px-2.5 lg:py-3.5`}>
      <span className="flex items-center gap-2 lg:px-2">
        <BrandMark className="h-9 w-9 lg:h-7 lg:w-7" title="Setti" />
        <span aria-hidden className="hidden text-[16px] font-bold tracking-[-0.01em] lg:inline">Setti</span>
      </span>

      <nav aria-label="Workspace modules" className="mt-5 flex flex-1 flex-col items-center gap-1.5 lg:items-stretch lg:gap-0.5">
        {itemsFor(account, demo).map(({ view: v, label, icon: Icon }) => {
          const active = view === v;
          const count = badges[v] ?? 0;
          // The number is what the reader has not seen yet; opening the inbox clears it.
          const name = !count ? label : `${label}, ${count} new`;
          return <button key={v} onClick={() => onView(v)} aria-label={name} aria-current={active ? "page" : undefined} title={name}
            className={`group relative flex w-[56px] flex-col items-center gap-1 rounded-lg py-1.5 lg:w-full lg:flex-row lg:gap-2.5 lg:px-2.5 lg:py-2 ${active ? "" : "lg:hover:bg-white"}`}>
            {/* The current module is marked by a bar at the sidebar's edge, so it never reads as a second logo. */}
            {active && <span aria-hidden className="absolute -left-1 top-2 h-8 w-[3px] rounded-r-full bg-[var(--ink)] lg:-left-2.5 lg:top-1/2 lg:h-5 lg:-translate-y-1/2" />}
            <span className={`relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors lg:h-5 lg:w-5 lg:rounded-none ${active ? "text-[var(--ink)]" : "text-slate-500 group-hover:bg-white group-hover:text-[var(--ink)] lg:group-hover:bg-transparent"}`}><Icon className="h-[18px] w-[18px]" />
              {count > 0 && <span aria-hidden className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-[var(--rail)] lg:hidden">{count > 99 ? "99+" : count}</span>}
            </span>
            <span className={`text-[10px] leading-none lg:text-[13px] ${active ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)] lg:font-medium lg:text-slate-600"}`}>{label}</span>
            {count > 0 && <span aria-hidden className="ml-auto hidden h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-semibold leading-none text-white lg:flex">{count > 99 ? "99+" : count}</span>}
          </button>;
        })}
      </nav>

      <div className="lg:hidden"><AccountMenu account={account} demo={demo} onSwitch={onSwitchAccount} compact placement="above" /></div>
      <div className="hidden lg:block"><AccountMenu account={account} demo={demo} onSwitch={onSwitchAccount} placement="above" /></div>
    </aside>
  );
}
