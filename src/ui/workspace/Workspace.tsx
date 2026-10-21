"use client";

import { CircleAlert, FileText } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import type { CaseKey } from "@/chat/types";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { willowApprovedQuote } from "@/quotes/willow-quote";
import { CaseChat } from "../chat/CaseChat";
import type { Conversation, Message } from "../demo-data";
import { agents, alerts, conversations, me } from "../demo-data";
import { ChatPane } from "./ChatPane";
import { ConversationList } from "./ConversationList";
import { AgentTag, Avatar } from "./primitives";
import { RightPanel, type PanelTab } from "./RightPanel";
import { Sidebar, type View } from "./Sidebar";

const ApprovedQuoteView = dynamic(() => import("../quotes/ApprovedQuoteView").then((m) => m.ApprovedQuoteView), {
  loading: () => <div className="flex flex-1 items-center justify-center rounded-xl bg-white text-sm text-[var(--muted)]">Loading quote…</div>,
});

const willowConversation: Conversation = {
  id: "willow",
  kind: "project",
  title: "Willow Residence",
  subtitle: "Whole home",
  counterpart: { id: "willow-client", name: "Sofia Martinez", role: "client", avatar: "/avatars/client.webp" },
  agents: ["change-agent"],
  preview: "Discuss changes, share product links and ask @AI to draft.",
  time: "",
  unread: 0,
  messages: [],
  items: [],
  files: [],
};
const workspaceConversations: Conversation[] = [willowConversation, ...conversations.map((conversation) => conversation.id === "maple" ? { ...conversation, preview: "Project chat · live AI drafts on request. Legacy demo kept separately.", unread: 0, time: "" } : conversation)];

export function Workspace({ initialView = "chats", initialQuote = "willow", initialCase }: { initialView?: View; initialQuote?: CaseKey; initialCase?: CaseKey }) {
  const [view, setView] = useState<View>(initialView);
  const [quoteId, setQuoteId] = useState<"maple" | "willow">(initialQuote);
  const [activeId, setActiveId] = useState<string>(initialCase ?? (initialView === "quotes" ? initialQuote : "willow"));
  const [read, setRead] = useState<Set<string>>(() => new Set(["maple", "willow"]));
  const [sent, setSent] = useState<Record<string, Message[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>("items");
  const [quietHours, setQuietHours] = useState(false);
  const [legacyMaple, setLegacyMaple] = useState(false);

  const active = workspaceConversations.find((c) => c.id === activeId) ?? workspaceConversations[0];
  const unreadOf = (c: Conversation) => (read.has(c.id) ? 0 : c.unread);
  const totalUnread = useMemo(() => workspaceConversations.reduce((n, c) => n + (read.has(c.id) ? 0 : c.unread), 0), [read]);
  const liveCase = active.id === "willow" || active.id === "maple" ? active.id : null;

  const open = (id: string) => {
    setActiveId(id);
    setLegacyMaple(false);
    setRead((prev) => new Set(prev).add(id));
    setView("chats");
  };

  const send = (text: string) => {
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const message: Message = { kind: "text", id: `local-${Date.now()}`, author: me.id, text, time };
    setSent((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), message] }));
  };

  const openMapleQuote = () => {
    setQuoteId("maple");
    setView("quotes");
  };
  const openCaseQuote = () => {
    setQuoteId(liveCase ?? "maple");
    setView("quotes");
  };

  return (
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      <div className="hidden shrink-0 xl:flex"><Sidebar view={view} onView={setView} unread={totalUnread} alertCount={alerts.length} quietHours={quietHours} onQuietHours={() => setQuietHours((q) => !q)} /></div>

      {view === "chats" && (
        <>
          <div className="hidden min-h-0 shrink-0 2xl:flex"><ConversationList conversations={workspaceConversations} activeId={active.id} onOpen={open} alerts={alerts.filter((alert) => alert.conversationId !== "maple")} unreadOf={unreadOf} /></div>
          {liveCase && !legacyMaple ? <CaseChat key={liveCase} projectKey={liveCase} quote={liveCase === "willow" ? willowApprovedQuote : mapleApprovedQuote} onOpenQuote={openCaseQuote} onSelectCase={open} onOpenLegacy={liveCase === "maple" ? () => setLegacyMaple(true) : undefined} /> : <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {legacyMaple && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800"><span>Legacy mock-up · prewritten history and local interactions are not sent to AI.</span><button onClick={() => setLegacyMaple(false)} className="font-semibold text-[var(--primary)] hover:underline">Back to live Maple chat</button></div>}
          <ChatPane
            conversation={active}
            messages={[...active.messages, ...(sent[active.id] ?? [])]}
            onSend={send}
            onOpenDetails={() => {
              setPanelOpen(true);
              setTab("money");
            }}
            onOpenQuote={openMapleQuote}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((o) => !o)}
          />
          </div>
          {panelOpen && <div className="hidden min-h-0 2xl:flex"><RightPanel conversation={active} tab={tab} onTab={setTab} onOpenQuote={openMapleQuote} /></div>}
          </>}
        </>
      )}

      {view === "alerts" && <AlertsView onOpen={open} />}
      {view === "agents" && <AgentsView onOpen={open} />}
      {view === "files" && <FilesView onOpen={open} />}
      {view === "quotes" && <ApprovedQuoteView key={quoteId} quote={quoteId === "willow" ? willowApprovedQuote : mapleApprovedQuote} onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); setLegacyMaple(false); }} onBack={() => setView("chats")} />}
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
