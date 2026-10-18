import { Bell, Bot, CalendarRange, FileSpreadsheet, FileText, LayoutList, MessageCircle, Moon, Search, Sun, UserPlus } from "lucide-react";
import type { ComponentType } from "react";
import { me } from "../demo-data";
import { Avatar, Badge } from "./primitives";

export type View = "chats" | "alerts" | "agents" | "quotes" | "items" | "procurement" | "files";

interface NavItem {
  view: View;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
}

export function Sidebar({
  view,
  onView,
  unread,
  alertCount,
  quietHours,
  onQuietHours,
}: {
  view: View;
  onView: (v: View) => void;
  unread: number;
  alertCount: number;
  quietHours: boolean;
  onQuietHours: () => void;
}) {
  const sections: { title?: string; items: NavItem[] }[] = [
    {
      items: [
        { view: "chats", label: "Chats", icon: MessageCircle, count: unread },
        { view: "alerts", label: "Alerts", icon: Bell, count: alertCount },
        { view: "agents", label: "Agents", icon: Bot },
      ],
    },
    {
      title: "Boards",
      items: [
        { view: "quotes", label: "Quotes", icon: FileSpreadsheet },
        { view: "items", label: "Items", icon: LayoutList },
        { view: "procurement", label: "Procurement", icon: CalendarRange },
      ],
    },
    { title: "Library", items: [{ view: "files", label: "Vendor files", icon: FileText }] },
  ];

  return (
    <aside className="flex w-[220px] shrink-0 flex-col px-2 py-3">
      <div className="flex items-center gap-2 px-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary)] text-sm font-bold text-white">S</span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Setti</div>
          <div className="text-[11px] text-[var(--muted)]">Lee Studio</div>
        </div>
      </div>

      <button className="mt-4 flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-[var(--muted)] hover:bg-white">
        <Search className="h-4 w-4" />
        Search
        <span className="ml-auto text-[11px]">Ctrl K</span>
      </button>

      <nav className="mt-2 flex-1 space-y-4 overflow-y-auto">
        {sections.map((section, i) => (
          <div key={section.title ?? i}>
            {section.title && <div className="px-2 pb-1 text-[11px] font-medium text-[var(--muted)]">{section.title}</div>}
            {section.items.map(({ view: v, label, icon: Icon, count }) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] ${
                  view === v ? "bg-white font-medium shadow-sm" : "hover:bg-white/70"
                }`}
              >
                <Icon className="h-4 w-4 text-[var(--muted)]" />
                {label}
                <Badge count={count ?? 0} />
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-1.5 border-t border-[var(--line)] px-1 pt-3">
        <Avatar person={me} size="sm" />
        <button
          onClick={onQuietHours}
          title={quietHours ? "Quiet hours on: client messages wait until 9 AM" : "Work hours: notifications on"}
          className="flex h-8 items-center gap-1 rounded-full bg-white px-2.5 text-[12px] shadow-sm"
        >
          {quietHours ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
          {quietHours ? "Quiet" : "Open"}
        </button>
        <button className="ml-auto flex h-8 items-center gap-1 whitespace-nowrap rounded-full bg-white px-2.5 text-[12px] shadow-sm">
          <UserPlus className="h-3.5 w-3.5" />
          Invite
        </button>
      </div>
    </aside>
  );
}
