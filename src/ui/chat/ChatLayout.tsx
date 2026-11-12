"use client";

import { AtSign, ChevronDown, Link2, SendHorizontal } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { Person } from "../demo-data";
import { Avatar } from "../workspace/primitives";

export function ChatHeader({ person, projectId, projectName, projects, onSelectProject, subtitle, children }: {
  person: Person;
  projectId: string;
  projectName: string;
  projects?: { key: string; title: string }[];
  onSelectProject?: (id: string) => void;
  subtitle: string;
  children: ReactNode;
}) {
  return <header className="flex flex-wrap items-center gap-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
    <Avatar person={person} />
    <div className="min-w-0 flex-1">
      {projects && onSelectProject ? <label className="relative flex w-fit max-w-full items-center">
        <select aria-label="Select project chat" value={projectId} onChange={(event) => onSelectProject(event.target.value)} className="max-w-full appearance-none truncate bg-transparent pr-5 text-[14px] font-semibold outline-none">
          {projects.map((project) => <option key={project.key} value={project.key}>{project.title}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-[var(--muted)]" />
      </label> : <h1 className="truncate text-[14px] font-semibold">{projectName}</h1>}
      <p className="truncate text-[11px] text-[var(--muted)]">{subtitle}</p>
    </div>
    {children}
  </header>;
}

export function ChatStatusBar({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 border-b border-[var(--line)] bg-slate-50/60 px-4 py-2 text-[10px] leading-relaxed text-slate-500 sm:px-5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /><span className="flex-1">{children}</span></div>;
}

/** Shared composer; workflow-specific attachments live in the leading-action slot. */
export function ChatComposer({ inputRef, text, onTextChange, disabled, onSubmit, onMentionAi, onAskAboutPayments, leadingAction, highlightSend = false }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (value: string) => void;
  disabled: boolean;
  onSubmit: () => void;
  onMentionAi: () => void;
  onAskAboutPayments?: () => void;
  leadingAction?: ReactNode;
  /** The next step is to send what is in the box: the button says so. */
  highlightSend?: boolean;
}) {
  return <div className="rounded-2xl border border-[var(--line)] bg-[var(--canvas)] px-3 py-2.5 focus-within:border-brand-200">
    <textarea ref={inputRef} aria-label="Project message" value={text} onChange={(event) => onTextChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); } }} disabled={disabled} placeholder="Discuss this case, paste a product link, or ask @Setti…" maxLength={8000} rows={2} className="max-h-40 min-h-[44px] w-full resize-y bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)] disabled:opacity-60" />
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {leadingAction}
      <button disabled={disabled} onClick={onMentionAi} title="Mention Setti" className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-50 disabled:opacity-50"><AtSign className="h-3 w-3" />Setti</button>
      {!text.trim() && onAskAboutPayments && <button disabled={disabled} onClick={onAskAboutPayments} className="rounded-full bg-white px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-50 disabled:opacity-50">Ask about payments</button>}
      <span className="hidden items-center gap-1 text-[10px] text-[var(--muted)] sm:flex"><Link2 className="h-3 w-3" />Paste product links in the message</span>
      {text.length > 7600 && <span className={`text-[10px] ${text.length > 8000 ? "text-red-600" : "text-[var(--muted)]"}`}>{text.length}/8000</span>}
      <button onClick={onSubmit} disabled={!text.trim() || text.trim().length > 8000 || disabled} aria-label="Send project message" className={`ml-auto inline-flex items-center gap-1.5 rounded-full bg-[var(--primary-fill)] text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400 ${highlightSend ? "px-3.5 py-2 text-[12px] font-semibold ring-4 ring-[var(--primary-soft)]" : "p-2"}`}>{highlightSend && "Send"}<SendHorizontal className="h-4 w-4" /></button>
    </div>
  </div>;
}
