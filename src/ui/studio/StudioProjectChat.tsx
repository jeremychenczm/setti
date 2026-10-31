"use client";

import { Bot, FileText, LoaderCircle, PanelRight, Plus, ReceiptText, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { DEMO_ACCOUNTS } from "@/accounts/demo";
import type { CaseMessage } from "@/chat/types";
import { STUDIO_STAGES, studioMoneyTotals, studioQuoteTotal, type StudioCase } from "@/demo/studio-types";
import type { StudioThreadSnapshot } from "@/studio/types";
import { usd, type Person } from "../demo-data";
import { ChatComposer, ChatHeader, ChatStatusBar } from "../chat/ChatLayout";
import { ChatMessageBubble } from "../chat/ChatMessageBubble";
import { PAYMENT_QUESTION } from "../chat/payment-question";
import { useDismiss } from "../useDismiss";
import { useResizableWidth } from "../useResizableWidth";

type RecordsTab = "quote" | "payments";
interface Props {
  project: StudioCase;
  projects: { key: string; title: string }[];
  onSelectProject: (id: string) => void;
  onOpenRecords: (tab: RecordsTab) => void;
}
const day = (at: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function StudioProjectChat({ project, projects, onSelectProject, onOpenRecords }: Props) {
  const [snapshot, setSnapshot] = useState<StudioThreadSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const pending = useRef<{ id: string; text: string } | null>(null);
  const active = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRoot = useRef<HTMLDivElement>(null);
  useDismiss(attachRoot, attachOpen, setAttachOpen);
  const panel = useResizableWidth("setti-project-panel-width", 420, 320, 360);
  const designer = DEMO_ACCOUNTS.find((person) => person.role === "designer")!;
  const client: Person = { id: project.id, name: project.client.name, role: "client" };
  const endpoint = `/api/studio/${project.id}/chat`;
  const readonly = project.stage === "settled";
  const stage = STUDIO_STAGES[project.stage];
  const totals = studioMoneyTotals(project);
  const running = sending || !!snapshot?.messages.some((message) => message.aiState === "running");

  const reload = useCallback(async () => {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load this conversation.");
      if (active.current) {
        setSnapshot(body);
        setError(null);
        const saved = pending.current;
        if (saved && body.messages.some((message: CaseMessage) => message.id === saved.id)) setText((value) => value.trim() === saved.text ? "" : value);
      }
    } catch (error) { if (active.current) setError(error instanceof Error ? error.message : "Could not load this conversation."); }
    finally { if (active.current) setLoading(false); }
  }, [endpoint]);

  useEffect(() => {
    active.current = true;
    void reload();
    return () => { active.current = false; };
  }, [reload]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [snapshot?.messages.length]);
  useEffect(() => {
    if (!sending && !snapshot?.messages.some((message) => message.aiState === "running")) return;
    const timer = setInterval(() => { void reload(); }, 4000);
    return () => clearInterval(timer);
  }, [sending, snapshot, reload]);

  async function send(retry?: CaseMessage) {
    if (readonly || running || !snapshot) return;
    const content = retry?.text ?? text.trim();
    if (!content) return;
    const payload = retry ? { id: retry.id, text: retry.text } : pending.current?.text === content ? pending.current : { id: crypto.randomUUID(), text: content };
    pending.current = payload;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(115000) });
      const body = await response.json();
      if (!active.current) return;
      const state = response.ok ? body : body.state;
      if (state) {
        setSnapshot(state);
        pending.current = null;
        if (!retry) setText((value) => value.trim() === content ? "" : value);
      }
      if (!response.ok) throw new Error(body.error || "The message was not confirmed saved. Retry to check it safely.");
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : "The response was lost. Retry the same message to continue safely.");
    } finally { if (active.current) setSending(false); }
  }

  function mentionAi() {
    setText((value) => /@ai\b/i.test(value) ? value : `@AI ${value}`);
    input.current?.focus();
  }

  function attachRecord(tab: RecordsTab) {
    const label = tab === "payments" ? "Project payment history" : `Quote V${project.quote.version}`;
    const link = `${window.location.origin}/quotes/${project.id}${tab === "payments" ? "?tab=payments" : ""}`;
    setText((value) => `${value}${value ? "\n" : ""}${label}: ${link}`);
    setAttachOpen(false);
    input.current?.focus();
  }

  return <section aria-label={`${project.name} project chat`} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
    <ChatHeader person={client} projectId={project.id} projectName={project.name} projects={projects} onSelectProject={onSelectProject} subtitle={`${designer.name} · ${client.name} · Change Agent`}>
      <button onClick={() => onOpenRecords("quote")} className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--primary)] hover:bg-brand-100"><FileText className="h-3.5 w-3.5" />Quote V{project.quote.version}{project.quote.status === "draft" ? " · Draft" : ""}</button>
      <button onClick={() => setDetailsOpen((open) => !open)} aria-label={detailsOpen ? "Close project details" : "Open project details"} aria-pressed={detailsOpen} className={`rounded-lg p-2 ${detailsOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}><PanelRight className="h-4 w-4" /></button>
    </ChatHeader>
    <ChatStatusBar>Demo case · saved to this browser session · {readonly ? "Completed project · read only" : `Prepared starting quote V${project.quote.version} · ${stage.label}`}</ChatStatusBar>
    <div ref={panel.rowRef} className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {snapshot?.aiConfigured === false && !readonly && <div role="status" className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-[11px] leading-relaxed text-amber-800">AI is not configured on this server. You can save messages; AI requests can be retried once it is available.</div>}
        <div role="log" aria-label="Project conversation" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-4">
            {loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading saved conversation…</div>}
            {snapshot?.messages.map((message, index) => {
              const previous = snapshot.messages[index - 1];
              const firstContinuation = !message.id.startsWith("prepared-") && previous?.id.startsWith("prepared-");
              return <div key={message.id}>
                {firstContinuation && <p className="mb-4 text-center text-[10px] text-[var(--muted)]">Your continuation of this project</p>}
                {(!previous || day(previous.createdAt) !== day(message.createdAt)) && <p className="mb-4 text-center text-[10px] text-[var(--muted)]">{day(message.createdAt)}</p>}
                <ChatMessageBubble message={message} person={message.actor === "designer" ? designer : client} own={message.actor === "designer"} highlighted={false} unsaved={false} running={running}
                  canRetryAi={!snapshot.messages.slice(index + 1).some((later) => later.actor !== "assistant")} onRetry={() => void send(message)} about={null} attachment={null} />
              </div>;
            })}
            {running && <div role="status" className="flex items-start gap-2.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Bot className="h-5 w-5" /></span><div className="rounded-xl bg-[var(--agent)] px-3.5 py-2.5 text-[12px] text-amber-900"><span className="flex items-center gap-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving the message and checking the request…</span><p className="mt-1 text-[10px] text-amber-800">Your conversation is kept in this case.</p></div></div>}
            {error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-relaxed text-red-800"><p>{error}</p><button disabled={running} onClick={() => void reload()} className="mt-2 flex items-center gap-1.5 font-medium hover:underline disabled:opacity-50"><RefreshCw className="h-3 w-3" />Reload saved chat</button></div>}
            <div ref={bottom} />
          </div>
        </div>
        <div className="border-t border-[var(--line)] bg-white px-4 py-3 sm:px-5">
          {readonly ? <p className="py-2 text-center text-[12px] text-[var(--muted)]">This project is settled. Its conversation, quotes and payment history remain available.</p> : <ChatComposer inputRef={input} text={text} onTextChange={setText} disabled={loading || !snapshot || running} onSubmit={() => void send()} onMentionAi={mentionAi}
            onAskAboutPayments={() => { setText(PAYMENT_QUESTION); input.current?.focus(); }}
            leadingAction={<div ref={attachRoot} className="relative"><button onClick={() => setAttachOpen((open) => !open)} disabled={loading || !snapshot || running} aria-haspopup="menu" aria-expanded={attachOpen} aria-label="Attach" className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[var(--primary)] hover:bg-brand-50 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>{attachOpen && <div role="menu" className="absolute bottom-full left-0 z-20 mb-2 w-60 rounded-xl border border-[var(--line)] bg-white p-1.5 shadow-lg"><button role="menuitem" onClick={() => attachRecord("quote")} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--canvas)]"><FileText className="mt-0.5 h-4 w-4 text-[var(--primary)]" /><span className="text-[12px]">Attach quote link</span></button><button role="menuitem" onClick={() => attachRecord("payments")} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[var(--canvas)]"><ReceiptText className="mt-0.5 h-4 w-4 text-[var(--primary)]" /><span className="text-[12px]">Attach payment history link</span></button></div>}</div>} />}
        </div>
      </div>
      {detailsOpen && <aside aria-label="Project summary" style={{ "--panel-width": `${panel.width}px` } as CSSProperties} className="absolute inset-y-0 right-0 z-20 flex w-full shrink-0 flex-col border-l border-[var(--line)] bg-white shadow-xl sm:w-[var(--panel-width)] 2xl:relative 2xl:shadow-none">
        <div role="separator" aria-orientation="vertical" aria-label="Resize the project panel" tabIndex={0} {...panel.handleProps} className="absolute inset-y-0 -left-1.5 z-30 hidden w-3 cursor-col-resize sm:block after:absolute after:inset-y-0 after:left-1.5 after:w-px after:bg-transparent hover:after:bg-brand-300 focus-visible:outline-none focus-visible:after:bg-brand-400" />
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3"><FileText className="h-4 w-4 text-[var(--primary)]" /><h2 className="flex-1 text-[13px] font-semibold">Project details</h2><button onClick={() => setDetailsOpen(false)} aria-label="Close project details panel" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div><p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Project status</p><h2 className="mt-2 text-[13px] font-semibold">{stage.label}</h2><p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">{stage.description}</p></div>
          <div className="rounded-lg border border-[var(--line)] bg-white p-3"><p className="text-[11px] text-[var(--muted)]">{project.quote.status === "draft" ? "Draft" : "Approved"} V{project.quote.version}</p><p className="mt-1 text-[18px] font-semibold">{usd(studioQuoteTotal(project.quote))}</p>{project.proposal && <p className="mt-2 text-[11px]">V{project.proposal.version} · {project.proposal.status === "declined" ? "Declined" : "Awaiting client"} · {usd(studioQuoteTotal(project.proposal))}</p>}<button onClick={() => onOpenRecords("quote")} className="mt-3 text-[11px] font-medium text-[var(--primary)]">Open quotes →</button></div>
          <div><p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Prepared payment history</p><dl className="mt-3 space-y-2 text-[11px]"><div className="flex justify-between"><dt>Held · not charged</dt><dd>{usd(totals.held)}</dd></div><div className="flex justify-between"><dt>Net paid</dt><dd>{usd(totals.netPaid)}</dd></div></dl><button onClick={() => onOpenRecords("payments")} className="mt-3 text-[11px] font-medium text-[var(--primary)]">View payment progress →</button></div>
          <div className="rounded-lg border border-[var(--primary-line)] bg-[var(--primary-soft)] p-3"><p className="text-[10px] uppercase text-[var(--primary)]">Next · {project.next.actor}</p><h2 className="mt-2 text-[12px] font-semibold">{project.next.title}</h2><p className="mt-2 text-[11px] leading-5">{project.next.detail}</p></div>
        </div>
      </aside>}
    </div>
  </section>;
}
