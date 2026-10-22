"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { CaseKey } from "@/chat/types";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { willowApprovedQuote } from "@/quotes/willow-quote";
import { CaseChat } from "../chat/CaseChat";
import { ConversationList, type ProjectChat } from "./ConversationList";
import { Sidebar, type View } from "./Sidebar";

const ApprovedQuoteView = dynamic(() => import("../quotes/ApprovedQuoteView").then((m) => m.ApprovedQuoteView), {
  loading: () => <div className="flex flex-1 items-center justify-center rounded-xl bg-white text-sm text-[var(--muted)]">Loading quote…</div>,
});

const quotes = { willow: willowApprovedQuote, maple: mapleApprovedQuote };

const projects: ProjectChat[] = [
  { key: "willow", title: "Willow Residence", subtitle: "Whole home", client: { id: "willow-client", name: "Sofia Martinez", role: "client", avatar: "/avatars/client.webp" } },
  { key: "maple", title: "Maple Ave", subtitle: "Window corner", client: { id: "emma", name: "Emma Park", role: "client", avatar: "/avatars/client.webp" } },
];

export function Workspace({ initialView = "chats", initialQuote = "willow", initialCase }: { initialView?: View; initialQuote?: CaseKey; initialCase?: CaseKey }) {
  const [view, setView] = useState<View>(initialView);
  const [quoteId, setQuoteId] = useState<CaseKey>(initialQuote);
  const [activeId, setActiveId] = useState<CaseKey>(initialCase ?? (initialView === "quotes" ? initialQuote : "willow"));

  const open = (key: CaseKey) => {
    setActiveId(key);
    setView("chats");
  };

  const openCaseQuote = () => {
    setQuoteId(activeId);
    setView("quotes");
  };

  return (
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      <div className="hidden shrink-0 xl:flex"><Sidebar view={view} onView={setView} /></div>

      {view === "chats" && (
        <>
          <div className="hidden min-h-0 shrink-0 2xl:flex"><ConversationList projects={projects} activeId={activeId} onOpen={open} /></div>
          <CaseChat key={activeId} projectKey={activeId} quote={quotes[activeId]} onOpenQuote={openCaseQuote} onSelectCase={open} />
        </>
      )}

      {view === "quotes" && <ApprovedQuoteView key={quoteId} quote={quotes[quoteId]} onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); }} onBack={() => setView("chats")} />}
    </div>
  );
}
