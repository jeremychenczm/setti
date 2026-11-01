import { FileSpreadsheet, FolderOpen, MessageCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import { AccountMenu } from "./AccountMenu";

export type View = "projects" | "chats" | "quotes";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** The designer sends quotes; a client receives them as proposals. */
function itemsFor(account: DemoAccount): NavItem[] {
  return [
    { view: "chats", label: "Chats", icon: MessageCircle },
    ...(account.role === "designer" ? [{ view: "projects" as const, label: "Projects", icon: FolderOpen }] : []),
    { view: "quotes", label: account.role === "designer" ? "Quotes" : "Proposals", icon: FileSpreadsheet },
  ];
}

/** The narrow icon rail at the left edge, as in a messaging app: modules on top, the account at the bottom. */
export function Sidebar({ view, onView, account, onSwitchAccount }: { view: View; onView: (v: View) => void; account: DemoAccount; onSwitchAccount: (id: AccountId) => void }) {
  return (
    <aside aria-label="Workspace sidebar" className="flex w-[64px] shrink-0 flex-col items-center bg-[var(--rail)] py-3">
      <span title="Setti · Lee Studio" className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--primary-fill)] text-[15px] font-bold text-[var(--on-primary)]">S</span>

      <nav aria-label="Workspace modules" className="mt-5 flex flex-1 flex-col items-center gap-1.5">
        {itemsFor(account).map(({ view: v, label, icon: Icon }) => {
          const active = view === v;
          return <button key={v} onClick={() => onView(v)} aria-label={label} aria-current={active ? "page" : undefined} title={label}
            className="group flex w-[56px] flex-col items-center gap-1 rounded-lg py-1.5">
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${active ? "bg-[var(--primary-fill)] text-[var(--on-primary)] shadow-sm" : "text-slate-500 group-hover:bg-white group-hover:text-[var(--ink)]"}`}><Icon className="h-[18px] w-[18px]" /></span>
            <span className={`text-[10px] leading-none ${active ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}>{label}</span>
          </button>;
        })}
      </nav>

      <AccountMenu account={account} onSwitch={onSwitchAccount} compact placement="above" />
    </aside>
  );
}
