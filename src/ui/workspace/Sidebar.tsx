import { FileSpreadsheet, MessageCircle } from "lucide-react";
import type { ComponentType } from "react";
import { me } from "../demo-data";
import { Avatar } from "./primitives";

export type View = "chats" | "quotes";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const sections: { title?: string; items: NavItem[] }[] = [
  { items: [{ view: "chats", label: "Chats", icon: MessageCircle }] },
  { title: "Boards", items: [{ view: "quotes", label: "Quotes", icon: FileSpreadsheet }] },
];

export function Sidebar({ view, onView }: { view: View; onView: (v: View) => void }) {
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
        {sections.map((section, i) => (
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

      <div className="flex items-center gap-2 border-t border-[var(--line)] px-1 pt-3">
        <Avatar person={me} size="sm" />
        <div className="leading-tight">
          <div className="text-[12px] font-medium">{me.name}</div>
          <div className="text-[11px] text-[var(--muted)]">Designer · demo account</div>
        </div>
      </div>
    </aside>
  );
}
