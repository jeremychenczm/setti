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
function sectionsFor(account: DemoAccount): { title?: string; items: NavItem[] }[] {
  return [
    { items: [{ view: "chats", label: "Chats", icon: MessageCircle }] },
    { title: "Boards", items: [...(account.role === "designer" ? [{ view: "projects" as const, label: "Projects", icon: FolderOpen }] : []), { view: "quotes", label: account.role === "designer" ? "Quotes" : "Proposals", icon: FileSpreadsheet }] },
  ];
}

export function Sidebar({ view, onView, account, onSwitchAccount }: { view: View; onView: (v: View) => void; account: DemoAccount; onSwitchAccount: (id: AccountId) => void }) {
  return (
    <aside aria-label="Workspace sidebar" className="flex w-[56px] shrink-0 flex-col px-1 py-3 lg:w-[204px] lg:px-2">
      <div className="flex items-center justify-center gap-2 px-1 lg:justify-start lg:px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-fill)] text-sm font-bold text-[var(--on-primary)]">S</span>
        <div className="hidden leading-tight lg:block">
          <div className="text-sm font-semibold">Setti</div>
          <div className="text-[11px] text-[var(--muted)]">Lee Studio</div>
        </div>
      </div>

      <nav aria-label="Workspace modules" className="mt-4 flex-1 space-y-4 overflow-y-auto">
        {sectionsFor(account).map((section, i) => (
          <div key={section.title ?? i}>
            {section.title && <div className="hidden px-2 pb-1 text-[11px] font-medium text-[var(--muted)] lg:block">{section.title}</div>}
            {section.items.map(({ view: v, label, icon: Icon }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                aria-label={label}
                aria-current={view === v ? "page" : undefined}
                title={label}
                className={`flex w-full items-center justify-center gap-2.5 rounded-lg px-2 py-2.5 text-[13px] lg:justify-start lg:py-1.5 ${
                  view === v ? "bg-[var(--primary-fill)] font-medium text-[var(--on-primary)] shadow-sm" : "hover:bg-white/70"
                }`}
              >
                <Icon className={`h-4 w-4 ${view === v ? "text-[var(--on-primary)]" : "text-[var(--muted)]"}`} />
                <span className="hidden lg:inline">{label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--line)] pt-2">
        <div className="hidden lg:block"><AccountMenu account={account} onSwitch={onSwitchAccount} /></div>
        <div className="flex justify-center lg:hidden"><AccountMenu account={account} onSwitch={onSwitchAccount} compact placement="above" /></div>
      </div>
    </aside>
  );
}
