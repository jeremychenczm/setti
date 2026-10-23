"use client";

import { AtSign, Bot, ChevronDown, FileText, Link2, LoaderCircle, MessageSquare, PanelRight, Plus, RefreshCw, SendHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isAiInvocation } from "@/ai/intent";
import { clientOf, DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseMessage, HumanActor } from "@/chat/types";
import type { QuoteDocument } from "@/quotes/types";
import type { Person } from "../demo-data";
import { TrySeedNotice } from "../try/TrySeedNotice";
import { AccountMenu } from "../workspace/AccountMenu";
import { useDismiss } from "../useDismiss";
import { useResizableWidth } from "../useResizableWidth";
import { Avatar } from "../workspace/primitives";
import { usd } from "../demo-data";
import { MoneyAnswerCard } from "./MoneyAnswerCard";
import { QuoteCard } from "./QuoteCard";
import { VersionCard } from "./VersionCard";
import { ReviewPanel } from "./ReviewPanel";
import { SendQuoteDialog } from "./SendQuoteDialog";
import { useCaseChat } from "./useCaseChat";

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
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function linkedText(value: string): ReactNode[] {
  return value.split(/(https?:\/\/[^\s<>，。！？、；：）】」』]+)/g).map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noreferrer" className="break-all text-[var(--primary)] underline decoration-blue-200 underline-offset-2">{part}</a>
    : <span key={index}>{part}</span>);
}

export function CaseChat({ projectKey, quote, account, onSwitchAccount, onOpenQuote, onSelectCase }: CaseChatProps) {
  const { snapshot, messages, loading, running, error, canRetry, unsavedMessageId, hasUnsent, send, sendQuote, retry, editUnsent, reload } = useCaseChat(projectKey);
  const actor: HumanActor = account.role;
  const [text, setText] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sendQuoteOpen, setSendQuoteOpen] = useState(false);
  const attachRoot = useRef<HTMLDivElement>(null);
  // The draft panel keeps at least 360px for the chat beside it.
  const panel = useResizableWidth("setti-draft-panel-width", 420, 320, 360);
  useDismiss(attachRoot, attachOpen, setAttachOpen);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentQuote = snapshot?.quote ?? quote;
  const confirmedQuoteHref = currentQuote.version > quote.version && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentQuote.id)
    ? `/change-orders/${currentQuote.id}` : null;
  const draft = snapshot?.draft ?? null;
  const designer: Person = DEMO_ACCOUNTS.find((person) => person.role === "designer")!;
  const client: Person = clientOf(projectKey);
  const sendDisabled = loading || running || !snapshot || hasUnsent;
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
  const mixedExampleAvailable = projectKey === "maple" && !draft
    && currentQuote.lines.some((line) => line.itemId === "chair")
    && currentQuote.lines.some((line) => line.itemId === "rug");

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, running]);

  useEffect(() => {
    if (draft?.id && account.role === "designer") setDraftOpen(true);
  }, [draft?.id, draft?.revision, account.role]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  function sourceMessage(id: string) {
    setDraftOpen(false);
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
    setText("@AI Replace the Lounge chair with one light oak writing desk and return the Wool rug. Keep all other items unchanged.");
    input.current?.focus();
  }

  function askAboutFunds() {
    setText("@AI Explain this project's recorded payments and anything still pending. Show the evidence.");
    input.current?.focus();
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <Avatar person={account.role === "designer" ? client : designer} />
        <div className="min-w-0 flex-1">
          {account.role === "designer" ? <label className="relative flex w-fit max-w-full items-center">
            <select aria-label="Select project chat" value={projectKey} onChange={(event) => onSelectCase(event.target.value as CaseKey)} className="max-w-full appearance-none truncate bg-transparent pr-5 text-[14px] font-semibold outline-none">
              <option value="willow">Willow Residence</option>
              <option value="maple">Maple Ave</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-[var(--muted)]" />
          </label> : <h1 className="truncate text-[14px] font-semibold">{currentQuote.projectName}</h1>}
          <p className="truncate text-[11px] text-[var(--muted)]">{designer.name} · {client.name} · Change Agent</p>
        </div>
        {opening?.status === "draft" && account.role === "client" ? null : confirmedQuoteHref ? <Link href={confirmedQuoteHref} aria-label={`View client-confirmed quote V${currentQuote.version}`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}{opening?.status === "draft" ? " · Draft" : ""}</button>}
        {account.role === "designer" && <button onClick={() => setDraftOpen((open) => !open)} aria-label={draftOpen ? "Close current draft" : "Open current draft"} aria-pressed={draftOpen} className={`rounded-lg p-2 ${draftOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}><PanelRight className="h-4 w-4" /></button>}
        <div className="xl:hidden"><AccountMenu account={account} onSwitch={onSwitchAccount} compact /></div>
      </header>

      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-slate-50/60 px-4 py-2 text-[10px] leading-relaxed text-slate-500 sm:px-5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /><span className="flex-1">Demo case · saved to this browser session · {openingStatusLine()}</span></div>

      <div ref={panel.rowRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {projectKey === "maple" && <TrySeedNotice />}
          {snapshot?.aiConfigured === false && <div role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[11px] leading-relaxed text-amber-800">AI is not configured on this server yet. You can still discuss this case; an @AI request will show a configuration error.</div>}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading saved conversation…</div>}
              {!loading && snapshot && messages.length === 0 && opening?.status === "draft" && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[var(--primary)]"><FileText className="h-6 w-6" strokeWidth={1.5} /></span>{account.role === "designer" ? <><h1 className="mt-4 text-[17px] font-semibold">Quote V1 is ready to send</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">{opening.lineCount} items prepared from your supplier quotes, {usd(opening.totalCents)} in total. Send it to {client.name} to start the project conversation.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={() => setSendQuoteOpen(true)} disabled={!canSendQuote} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-[12px] font-semibold text-white hover:bg-blue-600 disabled:bg-slate-200 disabled:text-slate-400"><SendHorizontal className="h-3.5 w-3.5" />Send quote V1</button><button onClick={() => onOpenQuote()} className="rounded-lg px-3 py-2 text-[12px] font-medium text-[var(--primary)] hover:bg-blue-50">Preview the quote</button></div></> : <><h1 className="mt-4 text-[17px] font-semibold">Waiting for the quote from {designer.name}</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">The studio will send quote V1 here. You can message the studio in the meantime.</p></>}</div>}
              {!loading && snapshot && messages.length === 0 && !openingPending && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[var(--primary)]"><MessageSquare className="h-6 w-6" strokeWidth={1.5} /></span><h1 className="mt-4 text-[17px] font-semibold">Start with the project conversation</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Discuss changes together and paste product links here. Mention <strong className="font-medium text-slate-700">@AI</strong> with what you want it to do when you are ready.</p><p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{confirmedQuoteHref ? "New changes use the client-confirmed" : "This case starts with the initial approved"} V{currentQuote.version} demo quote. The AI drafts for designer review; it cannot approve, order or move money.</p></div>}

              {messages.map((message, index) => <MessageBubble key={message.id} message={message} person={message.actor === "designer" ? designer : client} own={message.actor === actor} highlighted={highlightedId === message.id} unsaved={unsavedMessageId === message.id} running={running} canRetryAi={!messages.slice(index + 1).some((later) => later.actor !== "assistant")} onRetry={() => retry(message.id)} about={message.aboutItemId ? { name: lineName(message.aboutItemId), open: () => onOpenQuote(message.aboutItemId!) } : null} attachment={attachmentFor(message.id)} />)}

              {running && <div role="status" aria-live="polite" className="flex items-start gap-2.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-5 w-5" /></span><div className="rounded-xl bg-[var(--agent)] px-3.5 py-2.5 text-[12px] text-amber-900"><span className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving the message and checking the request…</span><p className="mt-1 text-[10px] text-amber-800">AI requests may take a minute or more. Your conversation is kept in this case.</p></div></div>}

              {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800"><p>{error}</p><div className="mt-2 flex flex-wrap gap-3">{canRetry && <button disabled={running} onClick={() => retry()} className="flex items-center gap-1.5 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry this message</button>}{hasUnsent && !running && <button onClick={() => { const unsent = editUnsent(); if (unsent) { setText(unsent.text); input.current?.focus(); } }} className="font-medium hover:underline">Edit unsent message</button>}{!running && !hasUnsent && <button onClick={() => void reload()} className="font-medium hover:underline">Reload saved chat</button>}</div></div>}

              {draft && account.role === "designer" && <button onClick={() => setDraftOpen(true)} className="flex w-full items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/50 p-3.5 text-left hover:bg-blue-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold">Current draft · {draft.title}</span><span className="mt-1 block text-[11px] text-slate-500">Awaiting designer pricing · based on V{draft.basedOnVersion} · View changes and sources</span></span><PanelRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /></button>}
              {snapshot?.draftPreparing && <div role="status" className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3.5 text-[12px] text-slate-600"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /><span>The studio is preparing a revised version of the quote. You will see it here once it is sent.</span></div>}
              <div ref={bottom} />
            </div>
          </div>

          <div className="border-t border-[var(--line)] bg-white px-4 py-3 sm:px-5">
            {mixedExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-blue-50/60 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="flex-1">One request can change several items. Each keeps its own payment progress.</span><button disabled={sendDisabled} onClick={tryMixedChange} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Try chair + rug example</button></div>}
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--canvas)] px-3 py-2.5 focus-within:border-blue-200">
              <textarea ref={input} aria-label="Project message" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} disabled={sendDisabled} placeholder="Discuss this case, paste a product link, or ask @AI…" maxLength={8000} rows={2} className="max-h-40 min-h-[44px] w-full resize-y bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)] disabled:opacity-60" />
              <div className="mt-1 flex flex-wrap items-center gap-2">{account.role === "designer" && <div ref={attachRoot} className="relative"><button onClick={() => setAttachOpen((value) => !value)} disabled={sendDisabled} aria-haspopup="menu" aria-expanded={attachOpen} aria-label="Attach" className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[var(--primary)] hover:bg-blue-50 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>{attachOpen && <div role="menu" className="absolute bottom-full left-0 z-20 mb-2 w-60 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg"><button role="menuitem" disabled={!canSendQuote} onClick={() => { setAttachOpen(false); setSendQuoteOpen(true); }} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--canvas)] disabled:cursor-not-allowed disabled:opacity-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0"><span className="block text-[12px] font-medium">Send quote V1</span><span className="block text-[11px] text-[var(--muted)]">{opening?.status === "draft" ? `${opening.lineCount} items · ${usd(opening.totalCents)}` : opening?.status === "sent" ? `Sent ${sentOn}` : "This project started from an approved quote"}</span></span></button></div>}</div>}<button disabled={sendDisabled} onClick={mentionAi} title="Mention AI" className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-50 disabled:opacity-50"><AtSign className="h-3 w-3" />AI</button>{!text.trim() && !openingPending && <button disabled={sendDisabled} onClick={askAboutFunds} className="rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-50 disabled:opacity-50">Ask about payments</button>}<span className="hidden items-center gap-1 text-[10px] text-[var(--muted)] sm:flex"><Link2 className="h-3 w-3" />Paste product links in the message</span>{text.length > 7600 && <span className={`text-[10px] ${text.length > 8000 ? "text-red-600" : "text-[var(--muted)]"}`}>{text.length}/8000</span>}<button onClick={submit} disabled={!text.trim() || text.trim().length > 8000 || sendDisabled} aria-label="Send project message" className="ml-auto rounded-full bg-[var(--primary)] p-2 text-white hover:bg-blue-600 disabled:bg-slate-200 disabled:text-slate-400"><SendHorizontal className="h-4 w-4" /></button></div>
            </div>
          </div>
        </div>

        {draftOpen && <aside aria-label="Current change draft" style={{ "--panel-width": `${panel.width}px` } as CSSProperties} className="absolute inset-y-0 right-0 z-20 flex w-full shrink-0 flex-col border-l border-[var(--line)] bg-white shadow-xl sm:w-[var(--panel-width)] 2xl:relative 2xl:shadow-none"><div role="separator" aria-orientation="vertical" aria-label="Resize the draft panel" tabIndex={0} {...panel.handleProps} className="absolute inset-y-0 -left-1.5 z-30 hidden w-3 cursor-col-resize sm:block after:absolute after:inset-y-0 after:left-1.5 after:w-px after:bg-transparent hover:after:bg-blue-300 focus-visible:outline-none focus-visible:after:bg-blue-400" /><div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3"><FileText className="h-4 w-4 text-[var(--primary)]" /><h2 className="flex-1 text-[13px] font-semibold">Current draft</h2><button onClick={() => setDraftOpen(false)} aria-label="Close draft panel" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-y-auto">{draft ? <ReviewPanel projectKey={projectKey} draft={draft} messages={messages} onSourceMessage={sourceMessage} canPrice={actor === "designer" && !running} /> : <div className="p-6 text-center"><FileText className="mx-auto h-6 w-6 text-slate-300" /><h3 className="mt-3 text-[13px] font-medium">No draft yet</h3><p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">Discuss your changes, then mention @AI and ask it to prepare a draft.</p>{confirmedQuoteHref ? <Link href={confirmedQuoteHref} className="mt-4 inline-block text-[12px] font-medium text-[var(--primary)] hover:underline">View client-confirmed quote V{currentQuote.version}</Link> : <button onClick={() => onOpenQuote()} className="mt-4 text-[12px] font-medium text-[var(--primary)] hover:underline">{openingPending ? "View quote V1" : `View approved quote V${currentQuote.version}`}</button>}</div>}</div></aside>}
      </div>
      {sendQuoteOpen && <SendQuoteDialog quote={currentQuote} clientName={client.name} onClose={() => setSendQuoteOpen(false)} onSend={sendQuote} onViewQuote={() => { setSendQuoteOpen(false); onOpenQuote(); }} />}
    </section>
  );
}

/** `own` marks the signed-in account's messages, shown on the right as in any chat app. */
function MessageBubble({ message, person, own, highlighted, unsaved, running, canRetryAi, onRetry, about, attachment }: { message: CaseMessage; person: Person; own: boolean; highlighted: boolean; unsaved: boolean; running: boolean; canRetryAi: boolean; onRetry: () => void; about: { name: string; open: () => void } | null; attachment: ReactNode }) {
  const assistant = message.actor === "assistant";
  return (
    <div id={`case-message-${message.id}`} className={`scroll-mt-5 rounded-xl transition-colors ${highlighted ? "bg-yellow-50 ring-2 ring-yellow-200" : ""}`}>
      <div className={`flex items-start gap-2.5 ${own ? "justify-end" : ""}`}>
        {!own && (assistant ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-5 w-5" /></span> : <Avatar person={person} />)}
        {own && <span className="order-last"><Avatar person={person} /></span>}
        <div className={`max-w-[88%] rounded-xl px-3.5 py-2.5 sm:max-w-[82%] ${assistant ? "bg-[var(--agent)]" : own ? "bg-[var(--primary-soft)]" : "bg-[var(--canvas)]"}`}>
          <div className={`mb-1 text-[11px] font-semibold ${assistant ? "text-amber-800" : "text-slate-600"}`}>{assistant ? message.moneyAnswer ? "Money Agent" : "Change Agent" : person.name}</div>
          {about && <button onClick={about.open} className="mb-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-blue-100 bg-white px-2 py-0.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-50"><FileText className="h-3 w-3 shrink-0" /><span className="truncate">About · {about.name} (V1)</span></button>}
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{linkedText(message.text)}</p>
          {attachment}
          {assistant && message.moneyAnswer && <MoneyAnswerCard answer={message.moneyAnswer} />}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]"><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>{unsaved && <span>{running ? "Sending…" : "Not saved yet"}</span>}{assistant && <span>{message.model === "system" ? "Guidance" : message.model ? `AI · ${message.model}` : "AI response"}</span>}{message.aiState === "failed" && <span className="text-red-600">AI request failed</span>}</div>
          {message.aiState === "failed" && <div className="mt-2 border-t border-red-100 pt-2 text-[11px] text-red-700"><p>{message.error ?? "The AI did not complete this request."}</p>{canRetryAi ? <button onClick={onRetry} disabled={running} className="mt-1 flex items-center gap-1 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry AI request</button> : <p className="mt-1">Newer discussion exists. Send a new @AI request.</p>}</div>}
        </div>
      </div>
    </div>
  );
}
