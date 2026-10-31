"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { accountOrDefault, canOpenProject, clientOf, DEMO_ACCOUNTS, rememberAccount, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { isCaseKey } from "@/chat/cases";
import { STUDIO_CASES, studioCase } from "@/demo/studio-cases";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import type { QuoteDocument } from "@/quotes/types";
import { willowQuote } from "@/quotes/willow-quote";
import { ConversationList, type ProjectChat } from "./ConversationList";
import { Sidebar, type View } from "./Sidebar";
import { TrySeedNotice } from "../try/TrySeedNotice";

const CaseChat = dynamic(() => import("../chat/CaseChat").then((m) => m.CaseChat), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading conversation…</div>,
});
const QuoteBoard = dynamic(() => import("../quotes/QuoteBoard").then((m) => m.QuoteBoard), {
  loading: () => <div className="flex flex-1 items-center justify-center rounded-xl bg-white text-sm text-[var(--muted)]">Loading quote…</div>,
});
const StudioProjectsModule = dynamic(() => import("../studio/StudioProjectsModule").then((m) => m.StudioProjectsModule), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading projects…</div>,
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

  useEffect(() => {
    function restoreRoute() {
      const url = new URL(window.location.href);
      if (url.pathname === "/studio" && account.role === "designer") { setView("projects"); return; }
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
    if (next === "projects" && account.role !== "designer") return;
    setView(next);
    if (next === "quotes") setRecordsTab("quote");
    const path = next === "projects" ? "/studio" : next === "quotes" ? `/quotes/${preparedProject?.id ?? quoteId}` : `/chats/${preparedProject?.id ?? activeId}`;
    window.history.replaceState(window.history.state, "", path);
  }

  function openPreparedProject(id: string) {
    if (account.role !== "designer" || !studioCase(id)) return;
    setPreparedCaseId(id);
    setView("chats");
    window.history.pushState(window.history.state, "", `/chats/${encodeURIComponent(id)}`);
  }

  const visibleProjects: ProjectChat[] = projects.filter((project) => canOpenProject(account, project.key))
    .map((project) => ({ ...project, counterpart: account.role === "designer" ? clientOf(project.key) : designer }));
  const conversations: ProjectChat<string>[] = [...visibleProjects, ...(account.role === "designer" ? STUDIO_CASES.map((project) => ({ key: project.id, title: project.name, subtitle: project.industry, counterpart: { id: project.id, name: project.client.name, role: "client" as const } })) : [])];

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
    if (next.role === "client" && (view === "projects" || preparedCaseId)) {
      setPreparedCaseId(null);
      setView("chats");
      window.history.replaceState(window.history.state, "", `/chats/${reachable(next, activeId)}`);
    }
  };

  return (
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      <Sidebar view={view} onView={showView} account={account} onSwitchAccount={switchAccount} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {view !== "projects" && !preparedProject && <TrySeedNotice projectKey={view === "chats" ? activeId : quoteId} account={account} onSwitchAccount={switchAccount} onOpenChat={() => { setActiveId(view === "quotes" ? quoteId : activeId); setView("chats"); }} currentView={view} />}
        <div className="flex min-h-0 min-w-0 flex-1 gap-2">
          {view === "projects" && account.role === "designer" && <StudioProjectsModule onOpenProject={openPreparedProject} />}
          {view === "chats" && (
            <>
              <div className="hidden min-h-0 shrink-0 2xl:flex"><ConversationList projects={conversations} activeId={preparedProject?.id ?? activeId} onOpen={open} /></div>
              {preparedProject ? <StudioProjectChat key={preparedProject.id} project={preparedProject} projects={conversations} onSelectProject={open} onOpenRecords={openPreparedRecords} /> : <CaseChat key={`${account.id}:${activeId}`} projectKey={activeId} quote={quotes[activeId]} account={account} onSwitchAccount={switchAccount} onOpenQuote={openCaseQuote} onSelectCase={open} conversationOptions={conversations} onSelectProject={open} />}
            </>
          )}

          {view === "quotes" && preparedProject && <StudioProjectRecords key={`${preparedProject.id}:${recordsTab}`} project={preparedProject} initialTab={recordsTab} onBack={openQuoteChat} onSelectTab={openPreparedRecords} />}
          {view === "quotes" && !preparedProject && <QuoteBoard key={`${account.id}:${quoteId}:${focusItemId ?? ""}`} projectKey={quoteId} viewer={account} options={visibleProjects.map((project) => project.key)} focusItemId={focusItemId}
            onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); setFocusItemId(null); }} onBack={openQuoteChat} onOpenChat={openQuoteChat} />}
        </div>
      </div>
    </div>
  );
}
