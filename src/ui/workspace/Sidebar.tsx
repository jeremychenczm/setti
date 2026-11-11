import { FileSpreadsheet, FolderOpen, Inbox, MessageCircle, Wallet } from "lucide-react";
import type { ComponentType } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import { AccountMenu } from "./AccountMenu";

export type View = "projects" | "chats" | "quotes" | "inbox" | "money";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** The designer sends quotes and keeps the money desk; a client receives quotes as proposals. */
function itemsFor(account: DemoAccount): NavItem[] {
  return [
    { view: "inbox", label: "Inbox", icon: Inbox },
    { view: "chats", label: "Chats", icon: MessageCircle },
    ...(account.role === "designer" ? [{ view: "projects" as const, label: "Projects", icon: FolderOpen }, { view: "money" as const, label: "Money", icon: Wallet }] : []),
    { view: "quotes", label: account.role === "designer" ? "Quotes" : "Proposals", icon: FileSpreadsheet },
  ];
}

/** The narrow icon rail at the left edge, as in a messaging app: modules on top, the account at the bottom. */
export function Sidebar({ view, onView, account, demo, onSwitchAccount, badges = {} }: { view: View; onView: (v: View) => void; account: DemoAccount; demo: boolean; onSwitchAccount: (id: AccountId) => void; badges?: Partial<Record<View, number>> }) {
  return (
    <aside aria-label="Workspace sidebar" className="flex w-[64px] shrink-0 flex-col items-center bg-[var(--rail)] py-3">
      <span title="Setti · Lee Studio" className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--primary-fill)] text-[15px] font-bold text-[var(--on-primary)]">S</span>

      <nav aria-label="Workspace modules" className="mt-5 flex flex-1 flex-col items-center gap-1.5">
        {itemsFor(account).map(({ view: v, label, icon: Icon }) => {
          const active = view === v;
          const count = badges[v] ?? 0;
          // The designer's number is what still needs doing; the client's is what is new.
          const name = !count ? label : account.role === "designer" ? `${label}, ${count} ${count === 1 ? "thing needs" : "things need"} you today` : `${label}, ${count} new`;
          return <button key={v} onClick={() => onView(v)} aria-label={name} aria-current={active ? "page" : undefined} title={name}
            className="group flex w-[56px] flex-col items-center gap-1 rounded-lg py-1.5">
            <span className={`relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${active ? "bg-[var(--primary-fill)] text-[var(--on-primary)] shadow-sm" : "text-slate-500 group-hover:bg-white group-hover:text-[var(--ink)]"}`}><Icon className="h-[18px] w-[18px]" />
              {count > 0 && <span aria-hidden className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-[var(--rail)]">{count > 99 ? "99+" : count}</span>}
            </span>
            <span className={`text-[10px] leading-none ${active ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}>{label}</span>
          </button>;
        })}
      </nav>

      <AccountMenu account={account} demo={demo} onSwitch={onSwitchAccount} compact placement="above" />
    </aside>
  );
}
