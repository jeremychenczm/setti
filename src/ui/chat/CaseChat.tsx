"use client";

import { AtSign, Bot, ChevronDown, FileText, Link2, LoaderCircle, MessageSquare, PanelRight, RefreshCw, SendHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAiInvocation } from "@/ai/intent";
import { clientOf, DEMO_ACCOUNTS, type AccountId, type DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseMessage, HumanActor } from "@/chat/types";
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { Person } from "../demo-data";
import { TrySeedNotice } from "../try/TrySeedNotice";
import { AccountMenu } from "../workspace/AccountMenu";
import { Avatar } from "../workspace/primitives";
import { DraftCard } from "./DraftCard";
import { MoneyAnswerCard } from "./MoneyAnswerCard";
import { useCaseChat } from "./useCaseChat";

interface CaseChatProps {
  projectKey: CaseKey;
  quote: ApprovedQuoteReport;
  /** The signed-in demo account; it is the only sender of new messages. */
  account: DemoAccount;
  onSwitchAccount: (id: AccountId) => void;
  onOpenQuote: () => void;
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
  const { snapshot, messages, loading, running, error, canRetry, unsavedMessageId, hasUnsent, send, retry, editUnsent, reload } = useCaseChat(projectKey);
  const actor: HumanActor = account.role;
  const [text, setText] = useState("");
  const [draftOpen, setDraftOpen] = useState(false);
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
  const mixedExampleAvailable = projectKey === "maple" && !draft
    && currentQuote.lines.some((line) => line.itemId === "chair")
    && currentQuote.lines.some((line) => line.itemId === "rug");

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, running]);

  useEffect(() => {
    if (draft?.id) setDraftOpen(true);
  }, [draft?.id, draft?.revision]);

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
        {confirmedQuoteHref ? <Link href={confirmedQuoteHref} aria-label={`View client-confirmed quote V${currentQuote.version}`} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}</Link> : <button onClick={onOpenQuote} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-100"><FileText className="h-3.5 w-3.5" />Quote V{currentQuote.version}</button>}
        <button onClick={() => setDraftOpen((open) => !open)} aria-label={draftOpen ? "Close current draft" : "Open current draft"} aria-pressed={draftOpen} className={`rounded-lg p-2 ${draftOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}><PanelRight className="h-4 w-4" /></button>
        <div className="xl:hidden"><AccountMenu account={account} onSwitch={onSwitchAccount} compact /></div>
      </header>

      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-slate-50/60 px-4 py-2 text-[10px] leading-relaxed text-slate-500 sm:px-5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /><span className="flex-1">Demo case · saved to this browser session · {confirmedQuoteHref ? "Client-confirmed baseline" : "Initial approved baseline"} V{currentQuote.version} · read-only</span></div>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {projectKey === "maple" && <TrySeedNotice />}
          {snapshot?.aiConfigured === false && <div role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[11px] leading-relaxed text-amber-800">AI is not configured on this server yet. You can still discuss this case; an @AI request will show a configuration error.</div>}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-3xl space-y-4">
              {loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading saved conversation…</div>}
              {!loading && snapshot && messages.length === 0 && <div className="mx-auto max-w-md px-2 py-10 text-center sm:py-16"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[var(--primary)]"><MessageSquare className="h-6 w-6" strokeWidth={1.5} /></span><h1 className="mt-4 text-[17px] font-semibold">Start with the project conversation</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Discuss changes together and paste product links here. Mention <strong className="font-medium text-slate-700">@AI</strong> with what you want it to do when you are ready.</p><p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{confirmedQuoteHref ? "New changes use the client-confirmed" : "This case starts with the initial approved"} V{currentQuote.version} demo quote. The AI drafts for designer review; it cannot approve, order or move money.</p></div>}

              {messages.map((message, index) => <MessageBubble key={message.id} message={message} person={message.actor === "designer" ? designer : client} highlighted={highlightedId === message.id} unsaved={unsavedMessageId === message.id} running={running} canRetryAi={!messages.slice(index + 1).some((later) => later.actor !== "assistant")} onRetry={() => retry(message.id)} />)}

              {running && <div role="status" aria-live="polite" className="flex items-start gap-2.5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-4 w-4" /></span><div className="rounded-xl bg-[var(--agent)] px-3.5 py-2.5 text-[12px] text-amber-900"><span className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving the message and checking the request…</span><p className="mt-1 text-[10px] text-amber-800">AI requests may take a minute or more. Your conversation is kept in this case.</p></div></div>}

              {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800"><p>{error}</p><div className="mt-2 flex flex-wrap gap-3">{canRetry && <button disabled={running} onClick={() => retry()} className="flex items-center gap-1.5 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry this message</button>}{hasUnsent && !running && <button onClick={() => { const unsent = editUnsent(); if (unsent) { setText(unsent.text); input.current?.focus(); } }} className="font-medium hover:underline">Edit unsent message</button>}{!running && !hasUnsent && <button onClick={() => void reload()} className="font-medium hover:underline">Reload saved chat</button>}</div></div>}

              {draft && <button onClick={() => setDraftOpen(true)} className="flex w-full items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/50 p-3.5 text-left hover:bg-blue-50"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /><span className="min-w-0 flex-1"><span className="block text-[12px] font-semibold">Current draft · {draft.title}</span><span className="mt-1 block text-[11px] text-slate-500">Awaiting designer pricing · based on V{draft.basedOnVersion} · View changes and sources</span></span><PanelRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" /></button>}
              <div ref={bottom} />
            </div>
          </div>

          <div className="border-t border-[var(--line)] bg-white px-4 py-3 sm:px-5">
            {mixedExampleAvailable && !text.trim() && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-blue-50/60 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><span className="flex-1">One request can change several items. Each keeps its own payment progress.</span><button disabled={sendDisabled} onClick={tryMixedChange} className="font-medium text-[var(--primary)] hover:underline disabled:opacity-50">Try chair + rug example</button></div>}
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--canvas)] px-3 py-2.5 focus-within:border-blue-200">
              <textarea ref={input} aria-label="Project message" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} disabled={sendDisabled} placeholder="Discuss this case, paste a product link, or ask @AI…" maxLength={8000} rows={2} className="max-h-40 min-h-[44px] w-full resize-y bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)] disabled:opacity-60" />
              <div className="mt-1 flex flex-wrap items-center gap-2"><button disabled={sendDisabled} onClick={mentionAi} title="Mention AI" className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-50 disabled:opacity-50"><AtSign className="h-3 w-3" />AI</button>{!text.trim() && <button disabled={sendDisabled} onClick={askAboutFunds} className="rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-blue-50 disabled:opacity-50">Ask about payments</button>}<span className="hidden items-center gap-1 text-[10px] text-[var(--muted)] sm:flex"><Link2 className="h-3 w-3" />Paste product links in the message</span>{text.length > 7600 && <span className={`text-[10px] ${text.length > 8000 ? "text-red-600" : "text-[var(--muted)]"}`}>{text.length}/8000</span>}<button onClick={submit} disabled={!text.trim() || text.trim().length > 8000 || sendDisabled} aria-label="Send project message" className="ml-auto rounded-full bg-[var(--primary)] p-2 text-white hover:bg-blue-600 disabled:bg-slate-200 disabled:text-slate-400"><SendHorizontal className="h-4 w-4" /></button></div>
            </div>
          </div>
        </div>

        {draftOpen && <aside aria-label="Current change draft" className="absolute inset-y-0 right-0 z-20 flex w-full shrink-0 flex-col border-l border-[var(--line)] bg-white shadow-xl sm:w-[360px] 2xl:static 2xl:w-[350px] 2xl:shadow-none"><div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3"><FileText className="h-4 w-4 text-[var(--primary)]" /><h2 className="flex-1 text-[13px] font-semibold">Current draft</h2><button onClick={() => setDraftOpen(false)} aria-label="Close draft panel" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-y-auto">{draft ? <DraftCard draft={draft} messages={messages} onSourceMessage={sourceMessage} pricingHref={`/pricing/${projectKey}`} canPrice={actor === "designer" && !running} /> : <div className="p-6 text-center"><FileText className="mx-auto h-6 w-6 text-slate-300" /><h3 className="mt-3 text-[13px] font-medium">No draft yet</h3><p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">Discuss your changes, then mention @AI and ask it to prepare a draft.</p>{confirmedQuoteHref ? <Link href={confirmedQuoteHref} className="mt-4 inline-block text-[12px] font-medium text-[var(--primary)] hover:underline">View client-confirmed quote V{currentQuote.version}</Link> : <button onClick={onOpenQuote} className="mt-4 text-[12px] font-medium text-[var(--primary)] hover:underline">View approved quote V{currentQuote.version}</button>}</div>}</div></aside>}
      </div>
    </section>
  );
}

function MessageBubble({ message, person, highlighted, unsaved, running, canRetryAi, onRetry }: { message: CaseMessage; person: Person; highlighted: boolean; unsaved: boolean; running: boolean; canRetryAi: boolean; onRetry: () => void }) {
  const assistant = message.actor === "assistant";
  const designer = message.actor === "designer";
  return (
    <div id={`case-message-${message.id}`} className={`scroll-mt-5 rounded-xl transition-colors ${highlighted ? "bg-yellow-50 ring-2 ring-yellow-200" : ""}`}>
      <div className={`flex items-start gap-2.5 ${designer ? "justify-end" : ""}`}>
        {!designer && (assistant ? <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-4 w-4" /></span> : <Avatar person={person} size="sm" />)}
        <div className={`max-w-[88%] rounded-xl px-3.5 py-2.5 sm:max-w-[82%] ${assistant ? "bg-[var(--agent)]" : designer ? "bg-[var(--primary-soft)]" : "bg-[var(--canvas)]"}`}>
          <div className={`mb-1 text-[11px] font-semibold ${assistant ? "text-amber-800" : "text-slate-600"}`}>{assistant ? message.moneyAnswer ? "Money Agent" : "Change Agent" : person.name}</div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{linkedText(message.text)}</p>
          {assistant && message.moneyAnswer && <MoneyAnswerCard answer={message.moneyAnswer} />}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]"><time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>{unsaved && <span>{running ? "Sending…" : "Not saved yet"}</span>}{assistant && <span>{message.model === "system" ? "Guidance" : message.model ? `AI · ${message.model}` : "AI response"}</span>}{message.aiState === "failed" && <span className="text-red-600">AI request failed</span>}</div>
          {message.aiState === "failed" && <div className="mt-2 border-t border-red-100 pt-2 text-[11px] text-red-700"><p>{message.error ?? "The AI did not complete this request."}</p>{canRetryAi ? <button onClick={onRetry} disabled={running} className="mt-1 flex items-center gap-1 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Retry AI request</button> : <p className="mt-1">Newer discussion exists. Send a new @AI request.</p>}</div>}
        </div>
      </div>
    </div>
  );
}
