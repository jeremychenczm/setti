import { FileSpreadsheet, MessageCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import { AccountMenu } from "./AccountMenu";

export type View = "chats" | "quotes";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** The designer sends quotes; a client receives them as proposals. */
function sectionsFor(account: DemoAccount): { title?: string; items: NavItem[] }[] {
  return [
    { items: [{ view: "chats", label: "Chats", icon: MessageCircle }] },
    { title: "Boards", items: [{ view: "quotes", label: account.role === "designer" ? "Quotes" : "Proposals", icon: FileSpreadsheet }] },
  ];
}

export function Sidebar({ view, onView, account, onSwitchAccount }: { view: View; onView: (v: View) => void; account: DemoAccount; onSwitchAccount: (id: AccountId) => void }) {
  return (
    <aside className="flex w-[220px] shrink-0 flex-col px-2 py-3">
      <div className="flex items-center gap-2 px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary)] text-sm font-bold text-white">S</span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Setti</div>
          <div className="text-[11px] text-[var(--muted)]">Lee Studio</div>
        </div>
      </div>

      <nav className="mt-4 flex-1 space-y-4 overflow-y-auto">
        {sectionsFor(account).map((section, i) => (
          <div key={section.title ?? i}>
            {section.title && <div className="px-2 pb-1 text-[11px] font-medium text-[var(--muted)]">{section.title}</div>}
            {section.items.map(({ view: v, label, icon: Icon }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] ${
                  view === v ? "bg-white font-medium shadow-sm" : "hover:bg-white/70"
                }`}
              >
                <Icon className="h-4 w-4 text-[var(--muted)]" />
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--line)] pt-2">
        <AccountMenu account={account} onSwitch={onSwitchAccount} />
      </div>
    </aside>
  );
}
