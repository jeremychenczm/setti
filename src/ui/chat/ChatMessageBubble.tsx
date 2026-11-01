"use client";

import { Bot, FileText, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { CaseMessage } from "@/chat/types";
import type { Person } from "../demo-data";
import { Avatar } from "../workspace/primitives";
import { MoneyAnswerCard } from "./MoneyAnswerCard";

export function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function linkedText(value: string): ReactNode[] {
  return value.split(/(https?:\/\/[^\s<>，。！？、；：）】」』]+)/g).map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noreferrer" className="break-all text-[var(--primary)] underline decoration-brand-200 underline-offset-2">{part}</a>
    : <span key={index}>{part}</span>);
}

/** `own` marks the signed-in account's messages, shown on the right as in any chat app. */
export function ChatMessageBubble({ message, person, own, highlighted, unsaved, running, canRetryAi, onRetry, about, attachment }: { message: CaseMessage; person: Person; own: boolean; highlighted: boolean; unsaved: boolean; running: boolean; canRetryAi: boolean; onRetry: () => void; about: { name: string; open: () => void } | null; attachment: ReactNode }) {
  const assistant = message.actor === "assistant";
  return (
    <div id={`case-message-${message.id}`} className={`scroll-mt-5 rounded-xl transition-colors ${highlighted ? "bg-yellow-50 ring-2 ring-yellow-200" : ""}`}>
      <div className={`flex items-start gap-2.5 ${own ? "justify-end" : ""}`}>
        {!own && (assistant ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-5 w-5" /></span> : <Avatar person={person} />)}
        {own && <span className="order-last"><Avatar person={person} /></span>}
        <div className={`max-w-[88%] rounded-xl px-3.5 py-2.5 sm:max-w-[82%] ${assistant ? "bg-[var(--agent)]" : own ? "bg-[var(--primary-soft)]" : "bg-[var(--canvas)]"}`}>
          <div className={`mb-1 text-[11px] font-semibold ${assistant ? "text-amber-800" : "text-slate-600"}`}>{assistant ? "Setti" : person.name}</div>
          {about && <button onClick={about.open} className="mb-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-brand-100 bg-white px-2 py-0.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-50"><FileText className="h-3 w-3 shrink-0" /><span className="truncate">About · {about.name} (V1)</span></button>}
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
