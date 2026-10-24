"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { accountOrDefault, canOpenProject, clientOf, DEMO_ACCOUNTS, rememberAccount, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import type { QuoteDocument } from "@/quotes/types";
import { willowQuote } from "@/quotes/willow-quote";
import { CaseChat } from "../chat/CaseChat";
import { ConversationList, type ProjectChat } from "./ConversationList";
import { Sidebar, type View } from "./Sidebar";

const QuoteBoard = dynamic(() => import("../quotes/QuoteBoard").then((m) => m.QuoteBoard), {
  loading: () => <div className="flex flex-1 items-center justify-center rounded-xl bg-white text-sm text-[var(--muted)]">Loading quote…</div>,
});

/** Each project's prepared V1, shown until the server's snapshot arrives. */
const quotes: Record<CaseKey, QuoteDocument> = { willow: willowQuote, maple: mapleApprovedQuote };

const projects: Omit<ProjectChat, "counterpart">[] = [
  { key: "willow", title: "Willow Residence", subtitle: "Whole home" },
  { key: "maple", title: "Maple Ave", subtitle: "Window corner" },
];
const designer = DEMO_ACCOUNTS.find((person) => person.role === "designer")!;

/** A client account only ever lands on its own project. */
function reachable(account: DemoAccount, wanted: CaseKey): CaseKey {
  return canOpenProject(account, wanted) ? wanted : account.projectKey ?? wanted;
}

export function Workspace({ initialView = "chats", initialQuote = "willow", initialCase, initialAccount }: { initialView?: View; initialQuote?: CaseKey; initialCase?: CaseKey; initialAccount?: string }) {
  const [account, setAccount] = useState<DemoAccount>(() => accountOrDefault(initialAccount));
  useEffect(() => { rememberAccount(account.id); }, [account.id]);
  const [view, setView] = useState<View>(initialView);
  const [quoteId, setQuoteId] = useState<CaseKey>(() => reachable(account, initialQuote));
  const [activeId, setActiveId] = useState<CaseKey>(() => reachable(account, initialCase ?? (initialView === "quotes" ? initialQuote : "willow")));
  /** The quote line to open, when the report is opened from a message about it. */
  const [focusItemId, setFocusItemId] = useState<string | null>(null);

  const visibleProjects: ProjectChat[] = projects.filter((project) => canOpenProject(account, project.key))
    .map((project) => ({ ...project, counterpart: account.role === "designer" ? clientOf(project.key) : designer }));

  const open = (key: CaseKey) => {
    setActiveId(key);
    setView("chats");
  };

  const openCaseQuote = (itemId?: string) => {
    setQuoteId(activeId);
    setFocusItemId(itemId ?? null);
    setView("quotes");
  };

  const openQuoteChat = () => {
    setActiveId(quoteId);
    setView("chats");
  };

  const switchAccount = (id: AccountId) => {
    const next = accountOrDefault(id);
    rememberAccount(next.id);
    setAccount(next);
    setActiveId((key) => reachable(next, key));
    setQuoteId((key) => reachable(next, key));
  };

  return (
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      <div className="hidden shrink-0 xl:flex"><Sidebar view={view} onView={setView} account={account} onSwitchAccount={switchAccount} /></div>

      {view === "chats" && (
        <>
          <div className="hidden min-h-0 shrink-0 2xl:flex"><ConversationList projects={visibleProjects} activeId={activeId} onOpen={open} /></div>
          <CaseChat key={`${account.id}:${activeId}`} projectKey={activeId} quote={quotes[activeId]} account={account} onSwitchAccount={switchAccount} onOpenQuote={openCaseQuote} onSelectCase={open} />
        </>
      )}

      {view === "quotes" && <QuoteBoard key={`${account.id}:${quoteId}:${focusItemId ?? ""}`} projectKey={quoteId} viewer={account} options={visibleProjects.map((project) => project.key)} focusItemId={focusItemId}
        onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); setFocusItemId(null); }} onBack={openQuoteChat} onOpenChat={openQuoteChat} />}
    </div>
  );
}
