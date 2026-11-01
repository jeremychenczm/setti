"use client";

import { Bot, FileText, LoaderCircle, MessageSquare, PanelRight, Plus, RefreshCw, SendHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isAiInvocation } from "@/ai/intent";
import { clientOf, DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseMessage, HumanActor } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";
import { isMapleSampleScope, MAPLE_MIXED_CHANGE_MESSAGE } from "@/demo/maple-materials";
import { HOME_DESIGNER_REQUEST } from "@/demo/living-dining";
import { isHomeQuote } from "@/demo/home-evidence";
import { HomeSupplierDocuments } from "../try/HomeSupplierDocuments";
import type { Person } from "../demo-data";
import { useDismiss } from "../useDismiss";
import { useResizableWidth } from "../useResizableWidth";
import { usd } from "../demo-data";
import { chatTimeline, latestChatMessage } from "./activity";
import { ActivityCard } from "./ActivityCard";
import { ChatMessageBubble as MessageBubble } from "./ChatMessageBubble";
import { ChatComposer, ChatHeader, ChatStatusBar } from "./ChatLayout";
import { QuoteCard } from "./QuoteCard";
import { VersionCard } from "./VersionCard";
import { ReviewPanel } from "./ReviewPanel";
import { SendQuoteDialog } from "./SendQuoteDialog";
import { useCaseChat } from "./useCaseChat";
import { PAYMENT_QUESTION, takePaymentQuestion } from "./payment-question";

interface CaseChatProps {
  projectKey: CaseKey;
  /** The project's prepared V1, until the snapshot gives the current baseline. */
  quote: QuoteDocument;
  /** The signed-in demo account; it is the only sender of new messages. */
  account: DemoAccount;
  onSwitchAccount: (id: AccountId) => void;
  /** Opens the quote report, at one line when a message is about it. */
  onOpenQuote: (itemId?: string) => void;
  onSelectCase: (projectKey: CaseKey) => void;
  conversationOptions?: { key: string; title: string }[];
  onSelectProject?: (id: string) => void;
  /** Told the latest message once the conversation loads and whenever it changes, for the chat list. */
  onLatest?: (message: CaseMessage | null) => void;
}

export function CaseChat({ projectKey, quote, account, onSwitchAccount, onOpenQuote, onSelectCase, conversationOptions, onSelectProject, onLatest }: CaseChatProps) {
  const { snapshot, messages, loading, running, error, canRetry, unsavedMessageId, hasUnsent, send, sendQuote, retry, editUnsent, reload } = useCaseChat(projectKey);
  const latest = latestChatMessage(messages);
  const reportLatest = useRef(onLatest);
  useEffect(() => { reportLatest.current = onLatest; });
  useEffect(() => { if (!loading) reportLatest.current?.(latest); }, [loading, latest]);
  const actor: HumanActor = account.role;
  const [text, setText] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sendQuoteOpen, setSendQuoteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const attachRoot = useRef<HTMLDivElement>(null);
  // The draft panel keeps at least 360px for the chat beside it.
  const panel = useResizableWidth("setti-draft-panel-width", 420, 320, 360);
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
  const designer: Person = DEMO_ACCOUNTS.find((person) => person.role === "designer")!;
  const client: Person = clientOf(projectKey);
  const sendDisabled = loading || running || !snapshot || hasUnsent;
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
  const canSendQuote = account.role === "designer" && opening?.status === "draft" && !sendDisabled;
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
    return index < 0 ? null : <VersionCard version={versions[index]} projectName={currentQuote.projectName} viewerRole={account.role} replacedBy={versions[index + 1]?.version ?? null} />;
  };
  const lineName = (itemId: string) => (currentQuote.lines.find((line) => line.itemId === itemId) ?? quote.lines.find((line) => line.itemId === itemId))?.name ?? itemId;
  const sentOn = opening?.sentAt ? new Date(opening.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const mixedExampleAvailable = projectKey === "maple" && !draft && isMapleSampleScope(currentQuote);
  const home = isHomeQuote(currentQuote);
  const discussionStart = home ? messages.findIndex((message) => message.model === "demo-scenario-discussion") : -1;
  const homeRequestStarted = discussionStart >= 0 && messages.slice(discussionStart).some((message) => message.actor === "designer" && isAiInvocation(message.text));
  const preparedVersionCount = messages.some((message) => message.actor === "assistant" && message.model === "demo-prepared-history") ? 1 : 0;
  const homeExampleAvailable = home && !draft && versions.length <= preparedVersionCount;
  const isStartingPaymentNote = (message: CaseMessage) => home && preparedVersionCount === 0 && message.actor === "assistant" && message.model === "system" && !message.replyToMessageId && /\bV1\b/.test(message.text);
  const startingPaymentNotes = messages.filter(isStartingPaymentNote);
  const lastConversationMessageId = messages.filter((message) => !isStartingPaymentNote(message)).at(-1)?.id;

  useEffect(() => {
    if (loading || !lastConversationMessageId) return;
    if (home && discussionStart >= 0 && !initiallyPositioned.current && !homeRequestStarted) document.getElementById("home-discussion-start")?.scrollIntoView({ block: "start" });
    else bottom.current?.scrollIntoView({ block: "end" });
    initiallyPositioned.current = true;
  }, [lastConversationMessageId, running, loading, home, discussionStart, homeRequestStarted]);

  useEffect(() => {
    if (draft?.id && account.role === "designer") setDraftOpen(true);
  }, [draft?.id, draft?.revision, account.role]);

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
    setText((previous) => isAiInvocation(previous) ? previous : `@AI ${previous}`);
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
      <ChatHeader person={account.role === "designer" ? client : designer} projectId={projectKey} projectName={currentQuote.projectName}
        projects={account.role === "designer" ? conversationOptions ?? [{ key: "willow", title: "Willow Residence" }, { key: "maple", title: "Maple Ave" }] : undefined}
        onSelectProject={account.role === "designer" ? (id) => onSelectProject ? onSelectProject(id) : onSelectCase(id as CaseKey) : undefined}
        subtitle={`${designer.name} · ${client.name} · Setti`}>
        {opening?.status === "draft" && account.role === "client" ? null : confirmedQuoteHref ? <Link href={confirmedQuoteHref} aria-label={`View client-confirmed quote V${currentQuote.version}`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}{opening?.status === "draft" ? " · Draft" : ""}</button>}
        {account.role === "designer" && <button onClick={() => setDraftOpen((open) => !open)} aria-label={draftOpen ? "Close current draft" : "Open current draft"} aria-pressed={draftOpen} className={`rounded-lg p-2 ${draftOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}><PanelRight className="h-4 w-4" /></button>}
      </ChatHeader>

      <ChatStatusBar>Demo case · saved to this browser session · {openingStatusLine()}</ChatStatusBar>

      <div ref={panel.rowRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {snapshot?.aiConfigured === false && <div role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[11px] leading-relaxed text-amber-800">AI is not configured on this server yet. You can still discuss this case; an @AI request will show a configuration error.</div>}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading saved conversation…</div>}
              {!loading && snapshot && messages.length === 0 && opening?.status === "draft" && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-[var(--primary)]"><FileText className="h-6 w-6" strokeWidth={1.5} /></span>{account.role === "designer" ? <><h1 className="mt-4 text-[17px] font-semibold">Quote V1 is ready to send</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">{opening.lineCount} items prepared from your supplier quotes, {usd(opening.totalCents)} in total. Send it to {client.name} to start the project conversation.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={() => setSendQuoteOpen(true)} disabled={!canSendQuote} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400"><SendHorizontal className="h-3.5 w-3.5" />Send quote V1</button><button onClick={() => onOpenQuote()} className="rounded-lg px-3 py-2 text-[12px] font-medium text-[var(--primary)] hover:bg-brand-50">Preview the quote</button></div></> : <><h1 className="mt-4 text-[17px] font-semibold">Waiting for the quote from {designer.name}</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">The studio will send quote V1 here. You can message the studio in the meantime.</p></>}</div>}
              {!loading && snapshot && messages.length === 0 && !openingPending && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-[var(--primary)]"><MessageSquare className="h-6 w-6" strokeWidth={1.5} /></span><h1 className="mt-4 text-[17px] font-semibold">Start with the project conversation</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Discuss changes together and paste product links here. Mention <strong className="font-medium text-slate-700">@AI</strong> with what you want it to do when you are ready.</p><p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{confirmedQuoteHref ? "New changes use the client-confirmed" : "This case starts with the initial approved"} V{currentQuote.version} demo quote. The AI drafts for designer review; it cannot approve, order or move money.</p></div>}

              {discussionStart > 0 && <details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500"><summary className="cursor-pointer font-medium">Earlier project history</summary><p className="mt-2">The initial agreement was prepared for this walkthrough. The new design discussion starts below.</p><div className="mt-4 space-y-4">{renderTimeline(messages.slice(0, discussionStart))}</div></details>}
              {startingPaymentNotes.length > 0 && <details className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-[11px] text-stone-600"><summary className="cursor-pointer font-medium">Starting payment records · V1 <span className="font-normal">· {startingPaymentNotes.length} saved updates</span></summary><div className="mt-4 space-y-4">{startingPaymentNotes.map((message) => renderMessage(message, messages.indexOf(message), true))}</div></details>}
              {discussionStart >= 0 && <div id="home-discussion-start" className="scroll-mt-3 rounded-xl border border-stone-200 bg-stone-50 p-4"><p className="text-[12px] font-semibold text-stone-800">A little more room to live</p><p className="mt-1 text-[11px] leading-relaxed text-stone-600">A prepared sample conversation between Emma and Jordan. They work through the living and dining layout together before asking for a revised quote. You can continue the discussion or prepare the proposal.</p></div>}
              {renderTimeline(discussionStart >= 0 ? messages.slice(discussionStart) : messages)}

              {running && <div role="status" aria-live="polite" className="flex items-start gap-2.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-5 w-5" /></span><div className="rounded-xl bg-[var(--agent)] px-3.5 py-2.5 text-[12px] text-amber-900"><span className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving the message and checking the request…</span><p className="mt-1 text-[10px] text-amber-800">AI requests may take a minute or more. Your conversation is kept in this case.</p></div></div>}

              {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800"><p>{error}</p><div className="mt-2 flex flex-wrap gap-3">{canRetry && <button disabled={running} onClick={() => retry()} className="flex items-center gap-1.5 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry this message</button>}{hasUnsent && !running && <button onClick={() => { const unsent = editUnsent(); if (unsent) { setText(unsent.text); input.current?.focus(); } }} className="font-medium hover:underline">Edit unsent message</button>}{!running && !hasUnsent && <button onClick={() => void reload()} className="font-medium hover:underline">Reload saved chat</button>}</div></div>}

              {draft && account.role === "designer" && <button onClick={() => setDraftOpen(true)} className="flex w-full items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/50 p-3.5 text-left hover:bg-brand-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold">Current draft · {draft.title}</span><span className="mt-1 block text-[11px] text-slate-500">Awaiting designer pricing · based on V{draft.basedOnVersion} · View changes and sources</span></span><PanelRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /></button>}
              {snapshot?.draftPreparing && <div role="status" className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3.5 text-[12px] text-slate-600"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /><span>The studio is preparing a revised version of the quote. You will see it here once it is sent.</span></div>}
              <div ref={bottom} />
            </div>
          </div>

          <div className="border-t border-[var(--line)] bg-white px-4 py-3 sm:px-5">
            {homeExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="min-w-40 flex-1">{account.role === "designer" ? "Ready to put the discussion into figures? AI will read the conversation and sample supplier documents." : "The design direction is agreed. Jordan prepares the revised quote for your review."}</span><button type="button" onClick={() => document.getElementById("home-discussion-start")?.scrollIntoView({ behavior: "smooth", block: "start" })} className="font-medium text-slate-700 underline underline-offset-2">Read from the start</button>{account.role === "designer" ? <button type="button" disabled={sendDisabled} onClick={prepareHomeQuote} className="rounded-md bg-[var(--primary-fill)] px-2.5 py-1.5 font-semibold text-[var(--on-primary)] disabled:opacity-50">Prepare the revised quote</button> : <button type="button" disabled={sendDisabled} onClick={() => onSwitchAccount("jordan")} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Continue as Jordan</button>}<span className="w-full text-[10px] text-slate-500">{account.role === "designer" ? "The button fills a request. Edit it and send when ready; the resulting proposal still needs your review." : "You can add a message below. A quote becomes agreed only when you review and formally confirm it."}</span></div>}
            {mixedExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50/60 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="flex-1">Replace the chair and return the rug in one request. Sample supplier details are available on Review pricing.</span><button disabled={sendDisabled} onClick={tryMixedChange} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Use chair + rug message</button><span className="w-full text-[10px] text-slate-500">Edit the message, then send it to ask AI for a review draft.</span></div>}
            <ChatComposer inputRef={input} text={text} onTextChange={setText} disabled={sendDisabled} onSubmit={submit} onMentionAi={mentionAi}
              onAskAboutPayments={!openingPending ? askAboutFunds : undefined}
              leadingAction={account.role === "designer" && <div ref={attachRoot} className="relative"><button onClick={() => setAttachOpen((value) => !value)} disabled={sendDisabled} aria-haspopup="menu" aria-expanded={attachOpen} aria-label="Attach" className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[var(--primary)] hover:bg-brand-50 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>{attachOpen && <div role="menu" className="absolute bottom-full left-0 z-20 mb-2 w-60 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg"><button role="menuitem" disabled={!canSendQuote} onClick={() => { setAttachOpen(false); setSendQuoteOpen(true); }} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--canvas)] disabled:cursor-not-allowed disabled:opacity-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0"><span className="block text-[12px] font-medium">Send quote V1</span><span className="block text-[11px] text-[var(--muted)]">{opening?.status === "draft" ? `${opening.lineCount} items · ${usd(opening.totalCents)}` : opening?.status === "sent" ? `Sent ${sentOn}` : "This project started from an approved quote"}</span></span></button></div>}</div>} />
          </div>
        </div>

        {draftOpen && <aside aria-label="Current change draft" style={{ "--panel-width": `${panel.width}px` } as CSSProperties} className="absolute inset-y-0 right-0 z-20 flex w-full shrink-0 flex-col border-l border-[var(--line)] bg-white shadow-xl sm:w-[var(--panel-width)] 2xl:relative 2xl:shadow-none"><div role="separator" aria-orientation="vertical" aria-label="Resize the draft panel" tabIndex={0} {...panel.handleProps} className="absolute inset-y-0 -left-1.5 z-30 hidden w-3 cursor-col-resize sm:block after:absolute after:inset-y-0 after:left-1.5 after:w-px after:bg-transparent hover:after:bg-brand-300 focus-visible:outline-none focus-visible:after:bg-brand-400" /><div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3"><FileText className="h-4 w-4 text-[var(--primary)]" /><h2 className="flex-1 text-[13px] font-semibold">Current draft</h2><button onClick={() => setDraftOpen(false)} aria-label="Close draft panel" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-y-auto">{draft ? <ReviewPanel projectKey={projectKey} draft={draft} messages={messages} onSourceMessage={sourceMessage} canPrice={actor === "designer" && !running} /> : <div className="p-6 text-center"><FileText className="mx-auto h-6 w-6 text-slate-300" /><h3 className="mt-3 text-[13px] font-medium">No draft yet</h3><p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">Discuss your changes, then mention @AI and ask it to prepare a draft.</p>{confirmedQuoteHref ? <Link href={confirmedQuoteHref} className="mt-4 inline-block text-[12px] font-medium text-[var(--primary)] hover:underline">View client-confirmed quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="mt-4 text-[12px] font-medium text-[var(--primary)] hover:underline">{openingPending ? "View quote V1" : `View approved quote V${currentQuote.version}`}</button>}</div>}</div></aside>}
      </div>
      {sendQuoteOpen && <SendQuoteDialog quote={currentQuote} clientName={client.name} onClose={() => setSendQuoteOpen(false)} onSend={sendQuote} onViewQuote={() => { setSendQuoteOpen(false); onOpenQuote(); }} />}
    </section>
  );
}
