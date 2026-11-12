"use client";

import dynamic from "next/dynamic";
import { FolderPlus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseMessage } from "@/chat/types";
import { isCaseKey } from "@/chat/cases";
import { STUDIO_CASES, studioCase } from "@/demo/studio-cases";
import type { ProjectPerson, ProjectSummary } from "@/projects/types";
import { latestChatMessage } from "../chat/activity";
import { ConversationList, type ChatPreview, type ProjectChat } from "./ConversationList";
import { NewProjectDialog } from "./NewProjectDialog";
import { Sidebar, type View } from "./Sidebar";
import { useInboxBadge } from "./useInboxBadge";
import { TrySeedNotice } from "../try/TrySeedNotice";
import { DemoModeProvider } from "../demo-mode";
import { DemoEndedNotice } from "../try/DemoEndedNotice";
import { switchPersona } from "../account/switchPersona";

const CaseChat = dynamic(() => import("../chat/CaseChat").then((m) => m.CaseChat), {
  loading: () => <div role="status" className="flex flex-1 items-center justify-center rounded-xl bg-white text-[13px] text-[var(--muted)]">Loading conversation…</div>,
});
const QuotesModule = dynamic(() => import("../quotes/QuotesModule").then((m) => m.QuotesModule), {
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

/** A project's client before one is added. */
const NO_CLIENT: ProjectPerson = { id: "no-client", name: "No client yet", role: "client" };

/** How the chat list names a message: "You" for the signed-in account, otherwise the sender's first name. */
function chatPreview(account: DemoAccount, people: { designer: ProjectPerson; client: ProjectPerson }, message: { actor: CaseMessage["actor"]; text: string; at: string }): ChatPreview {
  const from = message.actor === "assistant" ? "Setti" : message.actor === account.role ? "You" : people[message.actor].name.split(" ")[0];
  return { from, text: message.text.replace(/\s+/g, " ").trim(), at: message.at };
}

/**
 * The signed-in workspace. `account` is who the server signed in, as the page's
 * project sees them; `projects` are the ones they work in, read on the server;
 * `demo` lets a demo visitor switch between the demo's people.
 */
export function Workspace({ account, projects, demo = false, initialView = "chats", initialQuote, initialCase, initialPreparedCase = null, initialRecordsTab = "quote", initialVersion = null }: { account: DemoAccount; projects: ProjectSummary[]; demo?: boolean; initialView?: View; initialQuote?: CaseKey; initialCase?: CaseKey; initialPreparedCase?: string | null; initialRecordsTab?: "quote" | "payments"; initialVersion?: number | null }) {
  const canOpen = (key: string) => projects.some((project) => project.key === key);
  /** A project the viewer works in: the one asked for, else their first. */
  const reachable = (wanted: CaseKey | undefined): CaseKey | null => wanted && canOpen(wanted) ? wanted : projects[0]?.key ?? null;
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [view, setView] = useState<View>(initialView);
  const [quoteId, setQuoteId] = useState<CaseKey | null>(() => reachable(initialQuote ?? initialCase));
  const [activeId, setActiveId] = useState<CaseKey | null>(() => reachable(initialCase ?? initialQuote));
  const activeProject = projects.find((project) => project.key === activeId) ?? null;
  const peopleOf = (project: ProjectSummary) => ({ designer: project.designer, client: project.client ?? NO_CLIENT });
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
      else if (isCaseKey(id) && canOpen(id)) { setPreparedCaseId(null); setActiveId(id); setQuoteId(id); }
      else return;
      setRecordsTab(url.searchParams.get("tab") === "payments" ? "payments" : "quote");
      setView(match[1] === "quotes" ? "quotes" : "chats");
    }
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  });

  function showView(next: View) {
    if ((next === "projects" || next === "money") && account.role !== "designer") return;
    setView(next);
    if (next === "quotes") setRecordsTab("quote");
    const project = next === "quotes" ? preparedProject?.id ?? quoteId : preparedProject?.id ?? activeId;
    const path = next === "projects" ? "/studio" : next === "money" ? "/money" : next === "inbox" ? "/inbox" : project ? `/${next === "quotes" ? "quotes" : "chats"}/${project}` : null;
    if (path) window.history.replaceState(window.history.state, "", path);
  }

  function openPreparedProject(id: string) {
    if (account.role !== "designer" || !studioCase(id)) return;
    setPreparedCaseId(id);
    setView("chats");
    window.history.pushState(window.history.state, "", `/chats/${encodeURIComponent(id)}`);
  }

  /** The latest message of each live project chat: read once per account, then kept current by the open chat. */
  const [livePreviews, setLivePreviews] = useState<Partial<Record<CaseKey, ChatPreview | null>>>({});
  const showLatest = (project: ProjectSummary, message: CaseMessage | null) =>
    setLivePreviews((previous) => ({ ...previous, [project.key]: message ? chatPreview(account, peopleOf(project), { ...message, at: message.createdAt }) : null }));
  useEffect(() => {
    const controller = new AbortController();
    for (const project of projects) {
      fetch(`/api/chat/${project.key}`, { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ messages?: CaseMessage[] }> : null)
        .then((snapshot) => {
          const latest = Array.isArray(snapshot?.messages) ? latestChatMessage(snapshot.messages) : null;
          setLivePreviews((previous) => ({ ...previous, [project.key]: latest ? chatPreview(account, peopleOf(project), { ...latest, at: latest.createdAt }) : null }));
        })
        .catch(() => undefined);
    }
    return () => controller.abort();
    // The list is read once per page: a new project opens a new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  const visibleProjects: ProjectChat[] = projects.map((project) => {
    const counterpart = account.role === "designer" ? project.client ?? { id: `${project.key}:project`, name: project.name, role: "client" as const } : project.designer;
    const subtitle = account.role === "designer" && !project.client ? ["No client yet", project.subtitle].filter(Boolean).join(" · ") : project.subtitle;
    return { key: project.key, title: project.name, subtitle, counterpart, preview: livePreviews[project.key] ?? null };
  });
  // The demo's prepared studio projects sit beside a demo studio's own.
  const conversations: ProjectChat<string>[] = [...visibleProjects, ...(account.role === "designer" && demo ? STUDIO_CASES.map((project) => {
    const counterpart = { id: project.id, name: project.client.name, role: "client" as const };
    const latest = project.messages.at(-1);
    return { key: project.id, title: project.name, subtitle: project.industry, counterpart, preview: latest ? chatPreview(account, { designer: { id: account.id, name: account.name, role: "designer" }, client: counterpart }, latest) : null };
  }) : [])];

  const open = (key: string) => {
    if (studioCase(key)) { openPreparedProject(key); return; }
    if (!isCaseKey(key) || !canOpen(key)) return;
    setPreparedCaseId(null);
    setActiveId(key);
    setView("chats");
    window.history.pushState(window.history.state, "", `/chats/${key}`);
  };

  const openCaseQuote = (itemId?: string) => {
    if (!activeId) return;
    setQuoteId(activeId);
    setFocusItemId(itemId ?? null);
    setView("quotes");
    window.history.replaceState(window.history.state, "", `/quotes/${activeId}`);
  };

  const openQuoteChat = () => {
    setActiveId(quoteId);
    setView("chats");
    const project = preparedProject?.id ?? quoteId;
    if (project) window.history.replaceState(window.history.state, "", `/chats/${project}`);
  };

  const openPreparedRecords = (tab: "quote" | "payments") => {
    if (!preparedProject) return;
    setRecordsTab(tab);
    setView("quotes");
    window.history.replaceState(window.history.state, "", `/quotes/${preparedProject.id}${tab === "payments" ? "?tab=payments" : ""}`);
  };

  /** A demo visitor becomes another of the demo's people; a client lands in their own project's chat. */
  const switchAccount = (id: AccountId, next?: string) => {
    if (!demo) return;
    const person = DEMO_ACCOUNTS.find((option) => option.id === id);
    if (!person) return;
    const clientOnly = person.role === "client" && (view === "projects" || view === "money" || !!preparedCaseId || (view === "quotes" ? quoteId : activeId) !== person.projectKey);
    setSwitchError(null);
    void switchPersona(id, next ?? (clientOnly ? `/chats/${person.projectKey}` : undefined)).then(setSwitchError);
  };

  return (
    <DemoModeProvider value={demo}>
    <div className="flex h-dvh min-h-0 gap-2 bg-[var(--canvas)] p-2 text-[var(--ink)]">
      {/* The icon rail and the chat list are one panel, as in a messaging app; other modules keep only the rail. */}
      <div className="flex min-h-0 shrink-0 overflow-hidden rounded-xl bg-white shadow-sm">
        <Sidebar view={view} onView={showView} account={account} demo={demo} onSwitchAccount={switchAccount} badges={{ inbox: inboxCount }} />
        {view === "chats" && <div className="hidden min-h-0 border-l border-[var(--line)] lg:flex"><ConversationList projects={conversations} activeId={preparedProject?.id ?? activeId} onOpen={open}
          action={account.role === "designer" ? <button type="button" onClick={() => setNewProjectOpen(true)} aria-label="New project" title="New project" className="rounded-lg p-1.5 text-[var(--primary)] hover:bg-[var(--primary-soft)]"><Plus className="h-4 w-4" /></button> : undefined} /></div>}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <DemoEndedNotice />
        {switchError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{switchError}</p>}
        {demo && view !== "projects" && view !== "money" && !preparedProject && (view === "chats" ? activeId : quoteId) && <TrySeedNotice projectKey={(view === "chats" ? activeId : quoteId)!} account={account} onSwitchAccount={switchAccount} onOpenChat={() => { setActiveId(view === "quotes" ? quoteId : activeId); setView("chats"); }} onOpenInbox={() => showView("inbox")} currentView={view} />}
        <div className="flex min-h-0 min-w-0 flex-1 gap-2">
          {view === "projects" && account.role === "designer" && <StudioProjectsModule onOpenProject={openPreparedProject} />}
          {view === "inbox" && <InboxModule key={account.id} account={account} />}
          {view === "money" && account.role === "designer" && <MoneyModule onOpenInbox={() => showView("inbox")} />}
          {view === "chats" && (preparedProject
            ? <StudioProjectChat key={preparedProject.id} project={preparedProject} projects={conversations} onSelectProject={open} onOpenRecords={openPreparedRecords} />
            : activeProject
              ? <CaseChat key={`${account.id}:${activeProject.key}`} projectKey={activeProject.key} quote={activeProject.quote} designer={activeProject.designer} client={activeProject.client ?? NO_CLIENT} account={account} demo={demo} canInvite={account.role === "designer" && !demo && !activeProject.clientJoined} onSwitchAccount={switchAccount} onOpenQuote={openCaseQuote} onSelectCase={open} conversationOptions={conversations} onSelectProject={open} onLatest={(message) => showLatest(activeProject, message)} />
              : <NoProject designer={account.role === "designer"} onNew={() => setNewProjectOpen(true)} />)}

          {view === "quotes" && preparedProject && <StudioProjectRecords key={`${preparedProject.id}:${recordsTab}`} project={preparedProject} initialTab={recordsTab} onBack={openQuoteChat} onSelectTab={openPreparedRecords} />}
          {view === "quotes" && !preparedProject && (quoteId ? <QuotesModule key={`${account.id}:${quoteId}:${focusItemId ?? ""}`} projectKey={quoteId} version={quoteId === initialQuote ? initialVersion : null} demo={demo} clientName={projects.find((project) => project.key === quoteId)?.client?.name ?? "the client"} studioName={projects.find((project) => project.key === quoteId)?.studio ?? ""} viewer={account} options={projects.map((project) => ({ key: project.key, label: project.subtitle ? `${project.name} · ${project.subtitle}` : project.name }))} focusItemId={focusItemId}
            onSelectQuote={(id) => { setQuoteId(id); setActiveId(id); setFocusItemId(null); }} onBack={openQuoteChat} onOpenChat={openQuoteChat} />
            : <NoProject designer={account.role === "designer"} onNew={() => setNewProjectOpen(true)} />)}
        </div>
      </div>
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} />}
    </div>
    </DemoModeProvider>
  );
}

/** A studio without projects yet, or a client not yet added to one. */
function NoProject({ designer, onNew }: { designer: boolean; onNew: () => void }) {
  return <section className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-white p-6 shadow-sm">
    <div className="max-w-sm text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-[var(--primary)]"><FolderPlus className="h-6 w-6" strokeWidth={1.5} /></span>
      {designer ? <>
        <h1 className="mt-4 text-[17px] font-semibold">Create your first project</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-500">Each project has its own chat with the client, its quotes and its payments.</p>
        <button type="button" onClick={onNew} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"><Plus className="h-3.5 w-3.5" />New project</button>
      </> : <>
        <h1 className="mt-4 text-[17px] font-semibold">No project yet</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-500">Your designer adds you to a project. It appears here once they do.</p>
      </>}
    </div>
  </section>;
}
