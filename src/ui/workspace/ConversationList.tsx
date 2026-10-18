import { CircleAlert, Plus } from "lucide-react";
import type { Alert, Conversation } from "../demo-data";
import { AgentTag, Avatar } from "./primitives";

export function ConversationList({
  conversations,
  activeId,
  onOpen,
  alerts,
  unreadOf,
}: {
  conversations: Conversation[];
  activeId: string;
  onOpen: (id: string) => void;
  alerts: Alert[];
  unreadOf: (c: Conversation) => number;
}) {
  const projects = conversations.filter((c) => c.kind === "project");
  const agentDms = conversations.filter((c) => c.kind === "agent");

  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-2">
      <section className="rounded-xl bg-white p-3 shadow-sm">
        <div className="mb-2 text-[13px] font-semibold">Needs you today</div>
        <ul className="space-y-1">
          {alerts.map((a) => (
            <li key={a.id}>
              <button onClick={() => onOpen(a.conversationId)} className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--canvas)]">
                <CircleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${a.urgent ? "text-amber-600" : "text-[var(--muted)]"}`} />
                <span className="min-w-0">
                  <span className="block text-[13px] leading-snug">{a.text}</span>
                  <span className="text-[11px] text-[var(--muted)]">
                    {conversations.find((c) => c.id === a.conversationId)?.title} · {a.due}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-xl bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <h2 className="text-base font-semibold">Chats</h2>
          <button className="flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-white">
            <Plus className="h-3.5 w-3.5" />
            New project
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {projects.map((c) => (
            <Row key={c.id} c={c} active={c.id === activeId} unread={unreadOf(c)} onOpen={onOpen} />
          ))}
          <div className="px-2 pb-1 pt-3 text-[11px] font-medium text-[var(--muted)]">Agents</div>
          {agentDms.map((c) => (
            <Row key={c.id} c={c} active={c.id === activeId} unread={unreadOf(c)} onOpen={onOpen} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Row({ c, active, unread, onOpen }: { c: Conversation; active: boolean; unread: number; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(c.id)}
      className={`flex w-full gap-3 rounded-lg px-2 py-2.5 text-left ${active ? "bg-[var(--primary-soft)]" : "hover:bg-[var(--canvas)]"}`}
    >
      <Avatar person={c.counterpart} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{c.title}</span>
          {c.kind === "agent" ? <AgentTag /> : <span className="truncate text-[11px] text-[var(--muted)]">{c.subtitle}</span>}
          <span className="ml-auto shrink-0 text-[11px] text-[var(--muted)]">{c.time}</span>
        </span>
        <span className="mt-0.5 flex items-start gap-2">
          <span className={`line-clamp-2 text-[12px] leading-snug ${unread ? "text-[var(--ink)]" : "text-[var(--muted)]"}`}>{c.preview}</span>
          {unread > 0 && (
            <span className="ml-auto mt-0.5 min-w-5 shrink-0 rounded-full bg-[var(--primary)] px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
              {unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
