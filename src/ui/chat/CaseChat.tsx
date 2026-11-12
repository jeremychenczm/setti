"use client";

import { ArrowDownRight, Bot, Check, Circle, ClipboardCheck, FileText, LoaderCircle, MessageSquare, Plus, RefreshCw, SendHorizontal, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { isAiInvocation } from "@/ai/intent";
import type { AccountId, DemoAccount } from "@/accounts/demo";
import type { AiStage, CaseKey, CaseMessage, HumanActor } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";
import { isMapleSampleScope, MAPLE_MIXED_CHANGE_MESSAGE } from "@/demo/maple-materials";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";
import { isHomeQuote } from "@/demo/home-evidence";
import { HomeSupplierDocuments } from "../try/HomeSupplierDocuments";
import type { Person } from "../demo-data";
import { useDismiss } from "../useDismiss";
import { usd } from "../demo-data";
import { chatTimeline, latestChatMessage } from "./activity";
import { ActivityCard } from "./ActivityCard";
import { ChatMessageBubble as MessageBubble } from "./ChatMessageBubble";
import { ChatComposer, ChatHeader, ChatStatusBar } from "./ChatLayout";
import { QuoteCard } from "./QuoteCard";
import { VersionCard } from "./VersionCard";
import { ReviewPanel } from "./ReviewPanel";
import { InviteClientDialog } from "./InviteClientDialog";
import { SendQuoteDialog } from "./SendQuoteDialog";
import { useCaseChat } from "./useCaseChat";
import { PAYMENT_QUESTION, takePaymentQuestion } from "./payment-question";

interface CaseChatProps {
  projectKey: CaseKey;
  /** The project's prepared V1, until the snapshot gives the current baseline. */
  quote: QuoteDocument;
  /** The signed-in demo account; it is the only sender of new messages. */
  account: DemoAccount;
  /** The studio's designer and the project's client, as the server read them. */
  designer: Person;
  client: Person;
  /** A demo visitor, who can continue as the demo's other person. */
  demo?: boolean;
  /** A real studio's designer, before the project's client has joined: they may send an invite link. */
  canInvite?: boolean;
  onSwitchAccount: (id: AccountId) => void;
  /** Opens the quote report, at one line when a message is about it. */
  onOpenQuote: (itemId?: string) => void;
  onSelectCase: (projectKey: CaseKey) => void;
  conversationOptions?: { key: string; title: string }[];
  onSelectProject?: (id: string) => void;
  /** Told the latest message once the conversation loads and whenever it changes, for the chat list. */
  onLatest?: (message: CaseMessage | null) => void;
}

/** Each step of a running reply: what it says while active, once done, and before it starts. */
const STEPS: Record<AiStage, { active: string; done: string; pending: string }> = {
  reading: { active: "Reading the project records…", done: "Read the project records", pending: "Read the project records" },
  writing: { active: "Writing the reply…", done: "Wrote the reply", pending: "Write the reply" },
  rewriting: { active: "Correcting a detail that did not match the records…", done: "Corrected a detail that did not match the records", pending: "Correct a detail" },
  checking: { active: "Checking it against the records…", done: "Checked against the records", pending: "Check it against the records" },
};

/** The reply's progress as the server reports it: done steps ticked, the current one spinning. */
function ReplySteps({ stage, rewrote }: { stage: AiStage | null; rewrote: boolean }) {
  const steps: AiStage[] = ["reading", "writing", ...(rewrote || stage === "rewriting" ? ["rewriting" as const] : []), "checking"];
  const current = steps.indexOf(stage ?? "reading");
  return <ol className="space-y-1">
    {steps.map((step, index) => {
      const state = index < current ? "done" : index === current ? "active" : "pending";
      return <li key={step} className={`flex items-center gap-2 ${state === "pending" ? "text-amber-900/40" : ""}`}>
        {state === "done" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : state === "active" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-3.5 w-3.5" />}
        <span className={state === "active" ? "font-medium" : ""}>{STEPS[step][state]}</span>
      </li>;
    })}
  </ol>;
}

export function CaseChat({ projectKey, quote, account, designer, client, demo = false, canInvite = false, onSwitchAccount, onOpenQuote, onSelectCase, conversationOptions, onSelectProject, onLatest }: CaseChatProps) {
  const { snapshot, messages, loading, running, stage, rewrote, aiReplying, error, canRetry, unsavedMessageId, hasUnsent, send, sendQuote, retry, editUnsent, reload } = useCaseChat(projectKey);
  const latest = latestChatMessage(messages);
  const reportLatest = useRef(onLatest);
  useEffect(() => { reportLatest.current = onLatest; });
  useEffect(() => { if (!loading) reportLatest.current?.(latest); }, [loading, latest]);
  const actor: HumanActor = account.role;
  const [text, setText] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sendQuoteOpen, setSendQuoteOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const attachRoot = useRef<HTMLDivElement>(null);
  // The draft panel keeps at least 360px for the chat beside it.
  useDismiss(attachRoot, attachOpen, setAttachOpen);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const initiallyPositioned = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentQuote = snapshot?.quote ?? quote;
  const confirmedQuoteHref = currentQuote.version > quote.version && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentQuote.id)
    ? `/change-orders/${currentQuote.id}` : null;
  const draft = snapshot?.draft ?? null;
  const sendDisabled = loading || running || !snapshot || hasUnsent;
  /** The project has a client to send to; before one is added, the chat names none. */
  const hasClient = client.id !== "no-client";
  useEffect(() => {
    if (loading || !snapshot) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("ask") !== "payments") return;
    let requested = false;
    try { requested = takePaymentQuestion(url, projectKey, window.sessionStorage); }
    catch { /* With unavailable storage, leave an editable question instead. */ }
    url.searchParams.delete("ask");
    url.searchParams.delete("request");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (requested && !sendDisabled) {
      void send(actor, PAYMENT_QUESTION);
    } else {
      setText(PAYMENT_QUESTION);
      input.current?.focus();
      input.current?.scrollIntoView({ block: "center" });
    }
  }, [actor, loading, projectKey, send, sendDisabled, snapshot]);
  const opening = snapshot?.opening ?? null;
  const versions = snapshot?.versions ?? [];
  const latestVersion = versions.at(-1) ?? null;
  /** V1 is still a draft or with the client: there is no approved baseline to change yet. */
  const openingPending = opening !== null && opening.status !== "approved";
  const canSendQuote = account.role === "designer" && opening?.status === "draft" && opening.lineCount > 0 && !sendDisabled;
  /** Where V1 is with the client, until a confirmed change order becomes the baseline. */
  const openingStatusLine = () => {
    if (latestVersion && latestVersion.status !== "approved" && !confirmedQuoteHref) {
      const on = new Date(latestVersion.issuedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (latestVersion.status === "declined") return `Quote V${latestVersion.version} · the client asked for changes · V${latestVersion.basedOnVersion} remains the baseline`;
      return account.role === "designer" ? `Quote V${latestVersion.version} sent ${on} · awaiting client confirmation` : `Quote V${latestVersion.version} received ${on} · awaiting your confirmation`;
    }
    if (!opening || confirmedQuoteHref || !(opening.sentAt || opening.status === "draft")) return `${confirmedQuoteHref ? "Client-confirmed baseline" : "Initial approved baseline"} V${currentQuote.version} · read-only`;
    if (opening.status === "draft") return account.role === "designer" ? "Quote V1 is a draft, not yet sent to the client" : "Waiting for quote V1 from the studio";
    const { approved, pending } = opening.progress;
    if (approved) return `Quote V1 · ${approved} of ${opening.lineCount} lines approved${pending ? ` · ${pending} undecided` : ""}${opening.closed ? " · replaced by a newer version" : ""}`;
    if (account.role === "designer") return `Quote V1 sent ${sentOn} · locked · awaiting client review`;
    return pending ? `Quote V1 received ${sentOn} · awaiting your review` : `Quote V1 received ${sentOn}`;
  };
  /** The quote a designer's message carries: V1, or a later version sent into the chat. */
  const attachmentFor = (messageId: string) => {
    if (opening && opening.messageId === messageId) return <QuoteCard opening={opening} projectName={currentQuote.projectName} viewerRole={account.role} onOpen={() => onOpenQuote()} replacedBy={versions[0]?.version ?? null} />;
    const index = versions.findIndex((version) => version.messageId === messageId);
    return index < 0 ? null : <VersionCard version={versions[index]} projectKey={projectKey} projectName={currentQuote.projectName} viewerRole={account.role} replacedBy={versions[index + 1]?.version ?? null} />;
  };
  const lineName = (itemId: string) => (currentQuote.lines.find((line) => line.itemId === itemId) ?? quote.lines.find((line) => line.itemId === itemId))?.name ?? itemId;
  const sentOn = opening?.sentAt ? new Date(opening.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const mixedExampleAvailable = !draft && isMapleSampleScope(currentQuote);
  const home = isHomeQuote(currentQuote);
  const discussionStart = home ? messages.findIndex((message) => message.model === "demo-scenario-discussion") : -1;
  const homeRequestStarted = discussionStart >= 0 && messages.slice(discussionStart).some((message) => message.actor === "designer" && isAiInvocation(message.text));
  const preparedVersionCount = messages.some((message) => message.actor === "assistant" && message.model === "demo-prepared-history") ? 1 : 0;
  const homeExampleAvailable = home && !draft && versions.length <= preparedVersionCount;
  const isStartingPaymentNote = (message: CaseMessage) => home && preparedVersionCount === 0 && message.actor === "assistant" && message.model === "system" && !message.replyToMessageId && /\bV1\b/.test(message.text);
  const startingPaymentNotes = messages.filter(isStartingPaymentNote);
  const lastConversationMessageId = messages.filter((message) => !isStartingPaymentNote(message)).at(-1)?.id;
  // The walkthrough's first step: Jordan's request already waits in the box, so the next move is Send.
  const homeRequestReady = homeExampleAvailable && !homeRequestStarted && account.role === "designer";
  const prefilledHome = useRef(false);
  useEffect(() => {
    if (loading || prefilledHome.current || !homeRequestReady || snapshot?.activeMessageId) return;
    prefilledHome.current = true;
    setText((current) => current.trim() ? current : HOME_DESIGNER_REQUEST);
  }, [loading, homeRequestReady, snapshot?.activeMessageId]);
  const sendHomeRequest = homeRequestReady && isAiInvocation(text);

  useEffect(() => {
    if (loading || !lastConversationMessageId) return;
    if (home && discussionStart >= 0 && !initiallyPositioned.current && !homeRequestStarted) document.getElementById("home-discussion-start")?.scrollIntoView({ block: "start" });
    else bottom.current?.scrollIntoView({ block: "end" });
    initiallyPositioned.current = true;
  }, [lastConversationMessageId, running, loading, home, discussionStart, homeRequestStarted]);

  // The dialog opens by itself only for a draft that arrives while the chat is open, so a later
  // visit is not covered by it (the guide sits above the chat); the card in the chat opens it then.
  const seenDraft = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (loading) return;
    const key = draft?.id ? `${draft.id}:${draft.revision}` : null;
    if (seenDraft.current !== undefined && key && key !== seenDraft.current && account.role === "designer") setDraftOpen(true);
    seenDraft.current = key;
  }, [loading, draft?.id, draft?.revision, account.role]);

  // The draft is a dialog over the chat: Escape closes it, like a click outside it.
  useEffect(() => {
    if (!draftOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDraftOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [draftOpen]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  function sourceMessage(id: string) {
    setDraftOpen(false);
    if (discussionStart > 0 && messages.slice(0, discussionStart).some((message) => message.id === id)) setHistoryOpen(true);
    setHighlightedId(id);
    window.requestAnimationFrame(() => document.getElementById(`case-message-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 4000);
  }

  function submit() {
    const value = text.trim();
    if (!value || value.length > 8000 || sendDisabled) return;
    setText("");
    void send(actor, value);
  }

  function mentionAi() {
    setText((previous) => isAiInvocation(previous) ? previous : `@Setti ${previous}`);
    input.current?.focus();
  }

  function tryMixedChange() {
    setText(MAPLE_MIXED_CHANGE_MESSAGE);
    input.current?.focus();
  }

  function prepareHomeQuote() {
    setText(HOME_DESIGNER_REQUEST);
    input.current?.focus();
  }

  function renderMessage(message: CaseMessage, index: number, includeStartingPayment = false) {
    if (!includeStartingPayment && isStartingPaymentNote(message)) return null;
    if (home && message.model === "demo-supplier-notes") return <HomeSupplierDocuments key={message.id} id={`case-message-${message.id}`} text={message.text} highlighted={highlightedId === message.id} />;
    return <MessageBubble key={message.id} message={message} person={message.actor === "designer" ? designer : client} own={message.actor === actor} highlighted={highlightedId === message.id} unsaved={unsavedMessageId === message.id} running={running} canRetryAi={!messages.slice(index + 1).some((later) => later.actor !== "assistant")} onRetry={() => retry(message.id)} about={message.aboutItemId ? { name: lineName(message.aboutItemId), open: () => onOpenQuote(message.aboutItemId!) } : null} attachment={attachmentFor(message.id)} />;
  }

  /** Messages in order, with each run of saved records collapsed into one activity card. */
  function renderTimeline(list: CaseMessage[]) {
    return chatTimeline(list.filter((message) => !isStartingPaymentNote(message))).map((entry) => entry.kind === "activity"
      ? <ActivityCard key={entry.records[0].id} records={entry.records} highlightedId={highlightedId} />
      : renderMessage(entry.message, messages.indexOf(entry.message)));
  }

  function askAboutFunds() {
    setText(PAYMENT_QUESTION);
    input.current?.focus();
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
      <ChatHeader person={account.role === "designer" ? hasClient ? client : { id: `${projectKey}:project`, name: currentQuote.projectName, role: "client" } : designer} projectId={projectKey} projectName={currentQuote.projectName}
        projects={account.role === "designer" ? conversationOptions ?? [] : undefined}
        onSelectProject={account.role === "designer" ? (id) => onSelectProject ? onSelectProject(id) : onSelectCase(id as CaseKey) : undefined}
        subtitle={`${designer.name} · ${client.name} · Setti`}>
        {opening?.status === "draft" && account.role === "client" ? null : confirmedQuoteHref ? <Link href={confirmedQuoteHref} aria-label={`View client-confirmed quote V${currentQuote.version}`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}{opening?.status === "draft" ? " · Draft" : ""}</button>}
        {canInvite && <button onClick={() => setInviteOpen(true)} className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--primary-soft)]"><UserPlus className="h-3.5 w-3.5" />Invite client</button>}
        {account.role === "designer" && <button onClick={() => setDraftOpen((open) => !open)} aria-label={draftOpen ? "Close current draft" : "Open current draft"} aria-pressed={draftOpen} className={`rounded-lg p-2 ${draftOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}><FileText className="h-4 w-4" /></button>}
      </ChatHeader>

      <ChatStatusBar>{demo && "Demo case · saved to this browser session · "}{openingStatusLine()}</ChatStatusBar>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {snapshot?.aiConfigured === false && <div role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[11px] leading-relaxed text-amber-800">AI is not configured on this server yet. You can still discuss this case; an @Setti request will show a configuration error.</div>}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading saved conversation…</div>}
              {!loading && snapshot && messages.length === 0 && opening?.status === "draft" && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-[var(--primary)]"><FileText className="h-6 w-6" strokeWidth={1.5} /></span>{account.role === "designer" && opening.lineCount === 0 ? <><h1 className="mt-4 text-[17px] font-semibold">Quote V1 has no lines yet</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Add the items and services {hasClient ? client.name : "the client"} will decide on. You can send V1 once it has lines.</p><button onClick={() => onOpenQuote()} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"><FileText className="h-3.5 w-3.5" />Add lines</button></> : account.role === "designer" ? <><h1 className="mt-4 text-[17px] font-semibold">Quote V1 is ready to send</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">{opening.lineCount} {opening.lineCount === 1 ? "item" : "items"} prepared from your supplier quotes, {usd(opening.totalCents)} in total. Send it to {client.name} to start the project conversation.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={() => setSendQuoteOpen(true)} disabled={!canSendQuote} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400"><SendHorizontal className="h-3.5 w-3.5" />Send quote V1</button><button onClick={() => onOpenQuote()} className="rounded-lg px-3 py-2 text-[12px] font-medium text-[var(--primary)] hover:bg-brand-50">Preview the quote</button></div></> : <><h1 className="mt-4 text-[17px] font-semibold">Waiting for the quote from {designer.name}</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">The studio will send quote V1 here. You can message the studio in the meantime.</p></>}</div>}
              {!loading && snapshot && messages.length === 0 && !openingPending && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-[var(--primary)]"><MessageSquare className="h-6 w-6" strokeWidth={1.5} /></span><h1 className="mt-4 text-[17px] font-semibold">Start with the project conversation</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Discuss changes together and paste product links here. Mention <strong className="font-medium text-slate-700">@Setti</strong> with what you want it to do when you are ready.</p><p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{confirmedQuoteHref ? "New changes use the client-confirmed" : "This case starts with the initial approved"} V{currentQuote.version}{demo ? " demo quote" : " quote"}. The AI drafts for designer review; it cannot approve, order or move money.</p></div>}

              {discussionStart > 0 && <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500"><summary className="cursor-pointer font-medium">Earlier project history</summary><p className="mt-2">The initial agreement was prepared for this walkthrough. The new design discussion starts below.</p><div className="mt-4 space-y-4">{renderTimeline(messages.slice(0, discussionStart))}</div></details>}
              {startingPaymentNotes.length > 0 && <details className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-[11px] text-stone-600"><summary className="cursor-pointer font-medium">Starting payment records · V1 <span className="font-normal">· {startingPaymentNotes.length} saved updates</span></summary><div className="mt-4 space-y-4">{startingPaymentNotes.map((message) => renderMessage(message, messages.indexOf(message), true))}</div></details>}
              {discussionStart >= 0 && <div id="home-discussion-start" className="scroll-mt-3 rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-[12px] font-semibold text-stone-800">More seats by the window</p><p className="mt-1 text-[11px] leading-relaxed text-stone-600">A prepared sample conversation between Emma and Jordan. They work through the counter and back-bar changes together before asking for a revised quote. You can continue the discussion or prepare the proposal.</p></div>}
              {renderTimeline(discussionStart >= 0 ? messages.slice(discussionStart) : messages)}

              {running && <div role="status" aria-live="polite" className="flex items-start gap-2.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700"><Bot className="h-5 w-5" /></span><div className="rounded-xl bg-[var(--agent)] px-3.5 py-2.5 text-[12px] text-slate-700">{aiReplying ? <ReplySteps stage={stage} rewrote={rewrote} /> : <span className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving the message…</span>}{aiReplying && <p className="mt-1.5 text-[10px] text-slate-500">Replies are checked against the project records before they appear. Your conversation is kept in this case.</p>}</div></div>}

              {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800"><p>{error}</p><div className="mt-2 flex flex-wrap gap-3">{canRetry && <button disabled={running} onClick={() => retry()} className="flex items-center gap-1.5 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry this message</button>}{hasUnsent && !running && <button onClick={() => { const unsent = editUnsent(); if (unsent) { setText(unsent.text); input.current?.focus(); } }} className="font-medium hover:underline">Edit unsent message</button>}{!running && !hasUnsent && <button onClick={() => void reload()} className="font-medium hover:underline">Reload saved chat</button>}</div></div>}

              {draft && account.role === "designer" && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-100 bg-brand-50/50 p-3.5"><FileText className="h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-40 flex-1"><span className="block text-[12px] font-semibold">Current draft · {draft.changes.length} {draft.changes.length === 1 ? "change" : "changes"} to V{draft.basedOnVersion}</span><span className="mt-1 block text-[11px] text-slate-500">Awaiting designer pricing</span></span><button onClick={() => setDraftOpen(true)} className="shrink-0 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">Open the draft</button></div>}
              {snapshot?.draftPreparing && <div role="status" className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3.5 text-[12px] text-slate-600"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /><span>The studio is preparing a revised version of the quote. You will see it here once it is sent.</span></div>}
              <div ref={bottom} />
            </div>
          </div>

          <div className="border-t border-[var(--line)] bg-white px-4 py-3 sm:px-5">
            {sendHomeRequest && <div role="status" className="mb-3 flex items-start gap-2 rounded-lg bg-[var(--primary-soft)] px-3 py-2 text-[12px] leading-relaxed text-slate-800"><span className="flex-1"><b>Step 1: press Send.</b> Setti&apos;s AI reads the whole discussion and the supplier documents, then drafts the revised quote for you to review.</span><ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden="true" /></div>}
            {homeExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="min-w-40 flex-1">{account.role === "designer" ? "Ready to put the discussion into figures? AI will read the conversation and sample supplier documents." : "The design direction is agreed. Jordan prepares the revised quote for your review."}</span><button type="button" onClick={() => document.getElementById("home-discussion-start")?.scrollIntoView({ behavior: "smooth", block: "start" })} className="font-medium text-slate-700 underline underline-offset-2">Read from the start</button>{account.role === "designer" ? <button type="button" disabled={sendDisabled} onClick={prepareHomeQuote} className="rounded-md bg-[var(--primary-fill)] px-2.5 py-1.5 font-semibold text-[var(--on-primary)] disabled:opacity-50">Prepare the revised quote</button> : demo ? <button type="button" disabled={sendDisabled} onClick={() => onSwitchAccount("jordan")} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Continue as Jordan</button> : null}<span className="w-full text-[10px] text-slate-500">{account.role === "designer" ? "The button fills a request. Edit it and send when ready; the resulting proposal still needs your review." : "You can add a message below. A quote becomes agreed only when you review and formally confirm it."}</span></div>}
            {mixedExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50/60 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="flex-1">Replace the chair and return the rug in one request. Sample supplier details are available on Review pricing.</span><button disabled={sendDisabled} onClick={tryMixedChange} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Use chair + rug message</button><span className="w-full text-[10px] text-slate-500">Edit the message, then send it to ask AI for a review draft.</span></div>}
            <ChatComposer inputRef={input} text={text} onTextChange={setText} disabled={sendDisabled} onSubmit={submit} onMentionAi={mentionAi} highlightSend={sendHomeRequest}
              onAskAboutPayments={!openingPending ? askAboutFunds : undefined}
              leadingAction={account.role === "designer" && <div ref={attachRoot} className="relative"><button onClick={() => setAttachOpen((value) => !value)} disabled={sendDisabled} aria-haspopup="menu" aria-expanded={attachOpen} aria-label="Attach" className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[var(--primary)] hover:bg-brand-50 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>{attachOpen && <div role="menu" className="absolute bottom-full left-0 z-20 mb-2 w-60 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg"><button role="menuitem" disabled={!canSendQuote} onClick={() => { setAttachOpen(false); setSendQuoteOpen(true); }} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--canvas)] disabled:cursor-not-allowed disabled:opacity-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0"><span className="block text-[12px] font-medium">Send quote V1</span><span className="block text-[11px] text-[var(--muted)]">{opening?.status === "draft" ? `${opening.lineCount} items · ${usd(opening.totalCents)}` : opening?.status === "sent" ? `Sent ${sentOn}` : "This project started from an approved quote"}</span></span></button></div>}</div>} />
          </div>
        </div>

        {draftOpen && <div role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraftOpen(false); }} className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/45 p-3 sm:p-8">
          <section role="dialog" aria-modal="true" aria-labelledby="draft-dialog-title" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3.5">
              <FileText className="h-4 w-4 shrink-0 text-[var(--primary)]" />
              <div className="min-w-0 flex-1"><h2 id="draft-dialog-title" className="text-[14px] font-semibold">Current draft</h2>{draft && <p className="truncate text-[12px] text-[var(--muted)]">{currentQuote.projectName} · based on approved V{draft.basedOnVersion}</p>}</div>
              {draft && (actor === "designer" && !running
                ? <a href={`/pricing/${projectKey}`} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"><ClipboardCheck className="h-4 w-4" />Review pricing</a>
                : <span className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-slate-100 px-4 py-2 text-[13px] font-semibold text-slate-400" title="Available to the designer while the AI is not running"><ClipboardCheck className="h-4 w-4" />Review pricing</span>)}
              <button onClick={() => setDraftOpen(false)} aria-label="Close the draft" autoFocus className="shrink-0 rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">{draft ? <ReviewPanel projectKey={projectKey} draft={draft} messages={messages} onSourceMessage={sourceMessage} /> : <div className="p-6 text-center"><FileText className="mx-auto h-6 w-6 text-slate-300" /><h3 className="mt-3 text-[13px] font-medium">No draft yet</h3><p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">Discuss your changes, then mention @Setti and ask it to prepare a draft.</p>{confirmedQuoteHref ? <Link href={confirmedQuoteHref} className="mt-4 inline-block text-[12px] font-medium text-[var(--primary)] hover:underline">View client-confirmed quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="mt-4 text-[12px] font-medium text-[var(--primary)] hover:underline">{openingPending ? "View quote V1" : `View approved quote V${currentQuote.version}`}</button>}</div>}</div>
          </section>
        </div>}
      </div>
      {inviteOpen && <InviteClientDialog projectKey={projectKey} projectName={currentQuote.projectName} onClose={() => setInviteOpen(false)} />}
      {sendQuoteOpen && <SendQuoteDialog quote={currentQuote} clientName={client.name} onClose={() => setSendQuoteOpen(false)} onSend={sendQuote} onViewQuote={() => { setSendQuoteOpen(false); onOpenQuote(); }} />}
    </section>
  );
}
