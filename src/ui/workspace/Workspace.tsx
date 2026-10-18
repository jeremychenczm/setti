"use client";

import { CircleAlert, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import type { Conversation, Message } from "../demo-data";
import { agents, alerts, conversations, me } from "../demo-data";
import { ChatPane } from "./ChatPane";
import { ConversationList } from "./ConversationList";
import { AgentTag, Avatar } from "./primitives";
import { RightPanel, type PanelTab } from "./RightPanel";
import { Sidebar, type View } from "./Sidebar";

export function Workspace() {
  const [view, setView] = useState<View>("chats");
  const [activeId, setActiveId] = useState("maple");
  const [read, setRead] = useState<Set<string>>(() => new Set(["maple"]));
  const [sent, setSent] = useState<Record<string, Message[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>("items");
  const [quietHours, setQuietHours] = useState(false);

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  const unreadOf = (c: Conversation) => (read.has(c.id) ? 0 : c.unread);
  const totalUnread = useMemo(() => conversations.reduce((n, c) => n + (read.has(c.id) ? 0 : c.unread), 0), [read]);

  const open = (id: string) => {
    setActiveId(id);
    setRead((prev) => new Set(prev).add(id));
    setView("chats");
  };

  const send = (text: string) => {
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const message: Message = { kind: "text", id: `local-${Date.now()}`, author: me.id, text, time };
    setSent((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), message] }));
  };

  return (
    <div className="flex h-screen gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      <Sidebar view={view} onView={setView} unread={totalUnread} alertCount={alerts.length} quietHours={quietHours} onQuietHours={() => setQuietHours((q) => !q)} />

      {view === "chats" && (
        <>
          <ConversationList conversations={conversations} activeId={active.id} onOpen={open} alerts={alerts} unreadOf={unreadOf} />
          <ChatPane
            conversation={active}
            messages={[...active.messages, ...(sent[active.id] ?? [])]}
            onSend={send}
            onOpenDetails={() => {
              setPanelOpen(true);
              setTab("money");
            }}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((o) => !o)}
          />
          {panelOpen && <RightPanel conversation={active} tab={tab} onTab={setTab} />}
        </>
      )}

      {view === "alerts" && <AlertsView onOpen={open} />}
      {view === "agents" && <AgentsView onOpen={open} />}
      {view === "files" && <FilesView onOpen={open} />}
      {view === "items" && <ComingNext title="Items" text="Every item across projects, with its price, approval and money state." />}
      {view === "procurement" && <ComingNext title="Procurement" text="Order, ship, deliver and install dates, with hold expiry and refund due dates on the same timeline." />}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl bg-white shadow-sm">
      <h1 className="border-b border-[var(--line)] px-6 py-4 text-base font-semibold">{title}</h1>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

function AlertsView({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <Panel title="Alerts">
      <ul className="max-w-2xl space-y-1">
        {alerts.map((a) => {
          const c = conversations.find((x) => x.id === a.conversationId);
          return (
            <li key={a.id}>
              <button onClick={() => onOpen(a.conversationId)} className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--canvas)]">
                <CircleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${a.urgent ? "text-amber-600" : "text-[var(--muted)]"}`} />
                <span className="flex-1">
                  <span className="block text-[14px]">{a.text}</span>
                  <span className="text-[12px] text-[var(--muted)]">
                    {c?.title} · {c?.subtitle}
                  </span>
                </span>
                <span className={`text-[12px] ${a.urgent ? "font-medium text-amber-700" : "text-[var(--muted)]"}`}>{a.due}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AgentsView({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <Panel title="Agents">
      <p className="mb-4 max-w-2xl text-[13px] text-[var(--muted)]">
        Agents join your project chats. They read messages, vendor files and PayPal, draft and explain. Pricing, approval and moving money stay with people.
      </p>
      <div className="grid max-w-4xl grid-cols-1 gap-3 md:grid-cols-3">
        {agents.map((agent) => {
          const projects = conversations.filter((c) => c.kind === "project" && c.agents.includes(agent.id)).length;
          return (
            <div key={agent.id} className="flex flex-col rounded-xl border border-[var(--line)] p-4">
              <div className="flex items-center gap-2.5">
                <Avatar person={agent} size="lg" />
                <div>
                  <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                    {agent.name}
                    <AgentTag />
                  </div>
                  <div className="text-[12px] text-[var(--muted)]">
                    In {projects} {projects === 1 ? "project" : "projects"}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-[13px]">{agent.blurb}</p>
              <ul className="mt-2 flex-1 space-y-1.5 text-[12px] text-[var(--muted)]">
                {agent.can.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <button onClick={() => onOpen(`dm-${agent.id}`)} className="mt-4 rounded-full bg-[var(--primary-soft)] py-1.5 text-[13px] font-medium text-[var(--primary)]">
                Message
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function FilesView({ onOpen }: { onOpen: (id: string) => void }) {
  const files = conversations.flatMap((c) => c.files.map((f) => ({ ...f, conversation: c })));
  return (
    <Panel title="Vendor files">
      <ul className="max-w-3xl">
        {files.map((f) => (
          <li key={f.id}>
            <button onClick={() => onOpen(f.conversation.id)} className="flex w-full gap-3 rounded-lg px-3 py-3 text-left hover:bg-[var(--canvas)]">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="flex-1">
                <span className="block text-[14px] font-medium">{f.name}</span>
                <span className="text-[12px] text-[var(--muted)]">
                  {f.kind} · {f.summary}
                </span>
              </span>
              <span className="text-[12px] text-[var(--muted)]">
                {f.conversation.title} · {f.added}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ComingNext({ title, text }: { title: string; text: string }) {
  return (
    <Panel title={title}>
      <div className="px-6 py-16 text-center">
        <p className="text-[14px] text-[var(--muted)]">{text}</p>
      </div>
    </Panel>
  );
}
