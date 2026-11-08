"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { accountOrDefault, canOpenProject, clientOf, DEMO_ACCOUNTS, rememberAccount, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseMessage } from "@/chat/types";
import { isCaseKey } from "@/chat/cases";
import { STUDIO_CASES, studioCase } from "@/demo/studio-cases";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import type { QuoteDocument } from "@/quotes/types";
import { willowQuote } from "@/quotes/willow-quote";
import { latestChatMessage } from "../chat/activity";
import type { Person } from "../demo-data";
import { ConversationList, type ChatPreview, type ProjectChat } from "./ConversationList";
import { Sidebar, type View } from "./Sidebar";
import { useInboxBadge } from "./useInboxBadge";
import { TrySeedNotice } from "../try/TrySeedNotice";
import { DemoEndedNotice } from "../try/DemoEndedNotice";

const CaseChat = dynamic(() => import("../chat/CaseChat").then((m) => m.CaseChat), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading conversation…</div>,
});
const QuoteBoard = dynamic(() => import("../quotes/QuoteBoard").then((m) => m.QuoteBoard), {
  loading: () => <div className="flex flex-1 items-center justify-center rounded-xl bg-white text-sm text-[var(--muted)]">Loading quote…</div>,
});
const StudioProjectsModule = dynamic(() => import("../studio/StudioProjectsModule").then((m) => m.StudioProjectsModule), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading projects…</div>,
});
const InboxModule = dynamic(() => import("../inbox/Inbox").then((m) => m.Inbox), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading inbox…</div>,
});
const MoneyModule = dynamic(() => import("../money/MoneyDesk").then((m) => m.MoneyDesk), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading the money desk…</div>,
});
const StudioProjectChat = dynamic(() => import("../studio/StudioProjectChat").then((m) => m.StudioProjectChat));
const StudioProjectRecords = dynamic(() => import("../studio/PreparedProject").then((m) => m.StudioProjectRecords));

/** Each project's prepared V1, shown until the server's snapshot arrives. */
const quotes: Record<CaseKey, QuoteDocument> = { willow: willowQuote, maple: mapleApprovedQuote };

const projects: Omit<ProjectChat, "counterpart">[] = [
  { key: "willow", title: "Willow Residence", subtitle: "Whole home" },
  { key: "maple", title: "Maple Ave", subtitle: "Interior design" },
];
const designer = DEMO_ACCOUNTS.find((person) => person.role === "designer")!;

/** How the chat list names a message: "You" for the signed-in account, otherwise the sender's first name. */
function chatPreview(account: DemoAccount, client: Person, message: { actor: CaseMessage["actor"]; text: string; at: string }): ChatPreview {
  const from = message.actor === "assistant" ? "Coordinator" : message.actor === account.role ? "You" : (message.actor === "designer" ? designer : client).name.split(" ")[0];
  return { from, text: message.text.replace(/\s+/g, " ").trim(), at: message.at };
}

/** A client account only ever lands on its own project. */
function reachable(account: DemoAccount, wanted: CaseKey): CaseKey {
  return canOpenProject(account, wanted) ? wanted : account.projectKey ?? wanted;
}

export function Workspace({ initialView = "chats", initialQuote = "willow", initialCase, initialAccount, initialPreparedCase = null, initialRecordsTab = "quote" }: { initialView?: View; initialQuote?: CaseKey; initialCase?: CaseKey; initialAccount?: string; initialPreparedCase?: string | null; initialRecordsTab?: "quote" | "payments" }) {
  const [account, setAccount] = useState<DemoAccount>(() => accountOrDefault(initialAccount));
  useEffect(() => { rememberAccount(account.id); }, [account.id]);
  const [view, setView] = useState<View>(initialView);
  const [quoteId, setQuoteId] = useState<CaseKey>(() => reachable(account, initialQuote));
  const [activeId, setActiveId] = useState<CaseKey>(() => reachable(account, initialCase ?? (initialView === "quotes" ? initialQuote : "willow")));
  /** The quote line to open, when the report is opened from a message about it. */
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [preparedCaseId, setPreparedCaseId] = useState<string | null>(initialPreparedCase);
  const [recordsTab, setRecordsTab] = useState<"quote" | "payments">(initialRecordsTab);
  const preparedProject = account.role === "designer" && preparedCaseId ? studioCase(preparedCaseId) : null;
  // The designer's open reminders, or the client's money records not seen yet.
  const inboxCount = useInboxBadge(account.id);

  useEffect(() => {
    function restoreRoute() {
      const url = new URL(window.location.href);
      if (url.pathname === "/studio" && account.role === "designer") { setView("projects"); return; }
      if (url.pathname === "/inbox") { setView("inbox"); return; }
      if (url.pathname === "/money" && account.role === "designer") { setView("money"); return; }
      const match = /^\/(chats|quotes)\/([^/]+)$/.exec(url.pathname);
      if (!match) return;
      const id = decodeURIComponent(match[2]);
      if (studioCase(id) && account.role === "designer") setPreparedCaseId(id);
      else if (isCaseKey(id) && canOpenProject(account, id)) { setPreparedCaseId(null); setActiveId(id); setQuoteId(id); }
      else return;
      setRecordsTab(url.searchParams.get("tab") === "payments" ? "payments" : "quote");
      setView(match[1] === "quotes" ? "quotes" : "chats");
    }
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [account]);

  function showView(next: View) {
    if ((next === "projects" || next === "money") && account.role !== "designer") return;
    setView(next);
    if (next === "quotes") setRecordsTab("quote");
    const path = next === "projects" ? "/studio" : next === "money" ? "/money" : next === "inbox" ? "/inbox" : next === "quotes" ? `/quotes/${preparedProject?.id ?? quoteId}` : `/chats/${preparedProject?.id ?? activeId}`;
    window.history.replaceState(window.history.state, "", path);
  }

  function openPreparedProject(id: string) {
    if (account.role !== "designer" || !studioCase(id)) return;
    setPreparedCaseId(id);
    setView("chats");
    window.history.pushState(window.history.state, "", `/chats/${encodeURIComponent(id)}`);
  }

  /** The latest message of each live project chat: read once per account, then kept current by the open chat. */
  const [livePreviews, setLivePreviews] = useState<Partial<Record<CaseKey, ChatPreview | null>>>({});
  const showLatest = (key: CaseKey, message: CaseMessage | null) =>
    setLivePreviews((previous) => ({ ...previous, [key]: message ? chatPreview(account, clientOf(key), { ...message, at: message.createdAt }) : null }));
  useEffect(() => {
    const controller = new AbortController();
    for (const project of projects) {
      if (!canOpenProject(account, project.key)) continue;
      fetch(`/api/chat/${project.key}`, { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ messages?: CaseMessage[] }> : null)
        .then((snapshot) => {
          const latest = Array.isArray(snapshot?.messages) ? latestChatMessage(snapshot.messages) : null;
          setLivePreviews((previous) => ({ ...previous, [project.key]: latest ? chatPreview(account, clientOf(project.key), { ...latest, at: latest.createdAt }) : null }));
        })
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [account]);

  const visibleProjects: ProjectChat[] = projects.filter((project) => canOpenProject(account, project.key))
    .map((project) => ({ ...project, counterpart: account.role === "designer" ? clientOf(project.key) : designer, preview: livePreviews[project.key] ?? null }));
  const conversations: ProjectChat<string>[] = [...visibleProjects, ...(account.role === "designer" ? STUDIO_CASES.map((project) => {
    const counterpart = { id: project.id, name: project.client.name, role: "client" as const };
    const latest = project.messages.at(-1);
    return { key: project.id, title: project.name, subtitle: project.industry, counterpart, preview: latest ? chatPreview(account, counterpart, latest) : null };
  }) : [])];

  const open = (key: string) => {
    if (studioCase(key)) { openPreparedProject(key); return; }
    if (!isCaseKey(key) || !canOpenProject(account, key)) return;
    setPreparedCaseId(null);
    setActiveId(key);
    setView("chats");
    window.history.pushState(window.history.state, "", `/chats/${key}`);
  };

  const openCaseQuote = (itemId?: string) => {
    setQuoteId(activeId);
    setFocusItemId(itemId ?? null);
    setView("quotes");
    window.history.replaceState(window.history.state, "", `/quotes/${activeId}`);
  };

  const openQuoteChat = () => {
    setActiveId(quoteId);
    setView("chats");
    window.history.replaceState(window.history.state, "", `/chats/${preparedProject?.id ?? quoteId}`);
  };

  const openPreparedRecords = (tab: "quote" | "payments") => {
    if (!preparedProject) return;
    setRecordsTab(tab);
    setView("quotes");
    window.history.replaceState(window.history.state, "", `/quotes/${preparedProject.id}${tab === "payments" ? "?tab=payments" : ""}`);
  };

  const switchAccount = (id: AccountId) => {
    const next = accountOrDefault(id);
    rememberAccount(next.id);
    setAccount(next);
    setActiveId((key) => reachable(next, key));
    setQuoteId((key) => reachable(next, key));
    if (next.role === "client" && (view === "projects" || view === "money" || preparedCaseId)) {
      setPreparedCaseId(null);
      setView("chats");
      window.history.replaceState(window.history.state, "", `/chats/${reachable(next, activeId)}`);
    }
  };

  return (
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      {/* The icon rail and the chat list are one panel, as in a messaging app; other modules keep only the rail. */}
      <div className="flex min-h-0 shrink-0 overflow-hidden rounded-xl bg-white shadow-sm">
        <Sidebar view={view} onView={showView} account={account} onSwitchAccount={switchAccount} badges={{ inbox: inboxCount }} />
        {view === "chats" && <div className="hidden min-h-0 border-l border-[var(--line)] lg:flex"><ConversationList projects={conversations} activeId={preparedProject?.id ?? activeId} onOpen={open} /></div>}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <DemoEndedNotice />
        {view !== "projects" && view !== "money" && !preparedProject && <TrySeedNotice projectKey={view === "chats" ? activeId : quoteId} account={account} onSwitchAccount={switchAccount} onOpenChat={() => { setActiveId(view === "quotes" ? quoteId : activeId); setView("chats"); }} onOpenInbox={() => showView("inbox")} currentView={view} />}
        <div className="flex min-h-0 min-w-0 flex-1 gap-2">
          {view === "projects" && account.role === "designer" && <StudioProjectsModule onOpenProject={openPreparedProject} />}
          {view === "inbox" && <InboxModule key={account.id} account={account} />}
          {view === "money" && account.role === "designer" && <MoneyModule onOpenInbox={() => showView("inbox")} />}
          {view === "chats" && (preparedProject
            ? <StudioProjectChat key={preparedProject.id} project={preparedProject} projects={conversations} onSelectProject={open} onOpenRecords={openPreparedRecords} />
            : <CaseChat key={`${account.id}:${activeId}`} projectKey={activeId} quote={quotes[activeId]} account={account} onSwitchAccount={switchAccount} onOpenQuote={openCaseQuote} onSelectCase={open} conversationOptions={conversations} onSelectProject={open} onLatest={(message) => showLatest(activeId, message)} />)}

          {view === "quotes" && preparedProject && <StudioProjectRecords key={`${preparedProject.id}:${recordsTab}`} project={preparedProject} initialTab={recordsTab} onBack={openQuoteChat} onSelectTab={openPreparedRecords} />}
          {view === "quotes" && !preparedProject && <QuoteBoard key={`${account.id}:${quoteId}:${focusItemId ?? ""}`} projectKey={quoteId} viewer={account} options={visibleProjects.map((project) => project.key)} focusItemId={focusItemId}
            onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); setFocusItemId(null); }} onBack={openQuoteChat} onOpenChat={openQuoteChat} />}
        </div>
      </div>
    </div>
  );
}
