"use client";

import { ArrowDownLeft, ArrowUpRight, Check, CheckCheck, FileText, Link2, Lock, PanelRight, Paperclip, SendHorizontal, Unlock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChangeCardData, Conversation, Message, MoneyMove } from "../demo-data";
import { me, people, usd } from "../demo-data";
import { AgentTag, Avatar } from "./primitives";

export function ChatPane({
  conversation,
  messages,
  onSend,
  onOpenDetails,
  onOpenQuote,
  panelOpen,
  onTogglePanel,
}: {
  conversation: Conversation;
  messages: Message[];
  onSend: (text: string) => void;
  onOpenDetails: () => void;
  onOpenQuote?: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conversation.id]);

  const participants = conversation.kind === "project" ? [me, conversation.counterpart, ...conversation.agents.map((id) => people[id])] : [me, conversation.counterpart];

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3">
        <Avatar person={conversation.counterpart} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="truncate text-[15px] font-semibold">{conversation.title}</h1>
            {conversation.kind === "agent" && <AgentTag />}
          </div>
          <div className="truncate text-[12px] text-[var(--muted)]">
            {conversation.kind === "project" ? `${conversation.subtitle} · ${conversation.counterpart.name}` : conversation.subtitle}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {conversation.id === "maple" && onOpenQuote && (
            <button
              onClick={onOpenQuote}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--primary-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary)] hover:bg-[var(--primary)] hover:text-white"
            >
              <FileText className="h-3.5 w-3.5" />
              Quote V1
            </button>
          )}
          <span className="flex items-center gap-2 rounded-full bg-[var(--canvas)] py-1 pl-1 pr-3 text-[12px]">
            <span className="flex -space-x-1.5">
              {participants.slice(0, 4).map((p) => (
                <span key={p.id} className="rounded-full ring-2 ring-[var(--canvas)]">
                  <Avatar person={p} size="sm" />
                </span>
              ))}
            </span>
            {participants.length} in chat
          </span>
          <button
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            title="Project details"
            className={`rounded-lg p-2 ${panelOpen ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "text-[var(--muted)] hover:bg-[var(--canvas)]"}`}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {messages.map((m) => (
            <MessageView key={m.id} m={m} onOpenDetails={onOpenDetails} />
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <Composer
        placeholder={conversation.kind === "project" ? `Message ${conversation.counterpart.name.split(" ")[0]} and the agents...` : `Message ${conversation.title}...`}
        onSend={onSend}
      />
    </section>
  );
}

function MessageView({ m, onOpenDetails }: { m: Message; onOpenDetails: () => void }) {
  switch (m.kind) {
    case "date":
      return (
        <div className="flex justify-center pt-2">
          <span className="rounded-md bg-[var(--canvas)] px-2.5 py-1 text-[11px] text-[var(--muted)]">{m.label}</span>
        </div>
      );
    case "event":
      return (
        <div className="flex justify-center">
          <span className={`max-w-[85%] rounded-md px-2.5 py-1 text-center text-[12px] ${m.money ? "bg-emerald-50 text-emerald-800" : "bg-[var(--canvas)] text-[var(--muted)]"}`}>
            {m.text}
          </span>
        </div>
      );
    case "text":
      return <TextMessage m={m} />;
    case "suggestion":
      return <Suggestion m={m} />;
    case "change":
      return <ChangeCard card={m.card} time={m.time} onOpenDetails={onOpenDetails} />;
  }
}

function TextMessage({ m }: { m: Extract<Message, { kind: "text" }> }) {
  const author = people[m.author];
  const mine = author.id === me.id;
  const agent = author.role === "agent";
  const bubble = mine ? "bg-[var(--primary-soft)]" : agent ? "bg-[var(--agent)]" : "bg-[var(--canvas)]";

  return (
    <div className={`flex gap-2.5 ${mine ? "justify-end" : ""}`}>
      {!mine && <Avatar person={author} size="sm" />}
      <div className={`max-w-[75%] rounded-xl px-3.5 py-2 ${bubble}`}>
        {!mine && <div className={`mb-0.5 text-[12px] font-semibold ${agent ? "text-amber-800" : ""}`}>{author.name}</div>}
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{m.text}</p>
        {m.file && (
          <span className="mt-2 flex w-fit items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-[12px]">
            <FileText className="h-3.5 w-3.5 text-[var(--muted)]" />
            {m.file}
          </span>
        )}
        <div className={`mt-1 flex items-center gap-1 text-[11px] text-[var(--muted)] ${mine ? "justify-end" : ""}`}>
          {m.time}
          {mine && <CheckCheck className="h-3.5 w-3.5 text-[var(--primary)]" />}
        </div>
      </div>
    </div>
  );
}

function Suggestion({ m }: { m: Extract<Message, { kind: "suggestion" }> }) {
  const author = people[m.author];
  const [state, setState] = useState<"open" | "drafted" | "dismissed">(m.drafted ? "drafted" : "open");
  if (state === "dismissed") return null;

  return (
    <div className="flex gap-2.5">
      <Avatar person={author} size="sm" />
      <div className="max-w-[75%] rounded-xl bg-[var(--agent)] px-3.5 py-2">
        <div className="mb-0.5 text-[12px] font-semibold text-amber-800">{author.name}</div>
        <p className="text-[14px] leading-relaxed">{m.text}</p>
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          {state === "drafted" ? (
            <span className="flex items-center gap-1 font-medium text-emerald-700">
              <Check className="h-3.5 w-3.5" />
              Drafted
            </span>
          ) : (
            <>
              <button onClick={() => setState("drafted")} className="rounded-full bg-[var(--primary)] px-3 py-1 font-medium text-white">
                Draft change
              </button>
              <button onClick={() => setState("dismissed")} className="rounded-full px-2 py-1 text-[var(--muted)] hover:bg-white/60">
                Dismiss
              </button>
            </>
          )}
          <span className="ml-auto text-[var(--muted)]">
            Based on {m.sources} {m.sources === 1 ? "source" : "messages"} · {m.time}
          </span>
        </div>
      </div>
    </div>
  );
}

const MOVE_STYLE: Record<MoneyMove["kind"], { verb: string; icon: typeof Unlock; tone: string }> = {
  release: { verb: "Release", icon: Unlock, tone: "text-slate-600" },
  refund: { verb: "Refund", icon: ArrowDownLeft, tone: "text-violet-700" },
  hold: { verb: "Hold", icon: Lock, tone: "text-amber-700" },
  charge: { verb: "Charge", icon: ArrowUpRight, tone: "text-emerald-700" },
};

function ChangeCard({ card, time, onOpenDetails }: { card: ChangeCardData; time: string; onOpenDetails: () => void }) {
  const delta = card.budgetAfterCents - card.budgetBeforeCents;
  return (
    <div className="flex justify-end">
      <div className="w-[400px] max-w-full rounded-xl border border-[var(--line)] bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="rounded-md bg-[var(--primary-soft)] px-1.5 py-0.5 font-semibold text-[var(--primary)]">Change {card.version}</span>
          <span className="flex items-center gap-1 text-amber-700">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {card.status}
          </span>
          <span className="ml-auto text-[var(--muted)]">{time}</span>
        </div>
        <div className="mt-2 text-[15px] font-semibold">{card.title}</div>
        <div className="mt-1 flex items-baseline gap-2 text-[13px] text-[var(--muted)]">
          Budget {usd(card.budgetBeforeCents)} → <span className="font-semibold text-[var(--ink)]">{usd(card.budgetAfterCents)}</span>
          <span className="rounded-md bg-[var(--canvas)] px-1.5 text-[12px] font-medium text-[var(--ink)]">
            {delta >= 0 ? "+" : "−"}
            {usd(Math.abs(delta))}
          </span>
        </div>

        <ul className="mt-3 space-y-2 border-t border-[var(--line)] pt-3">
          {card.moves.map((move) => {
            const { verb, icon: Icon, tone } = MOVE_STYLE[move.kind];
            return (
              <li key={move.label} className="flex items-start gap-2.5">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">
                    {verb} · {move.label}
                  </span>
                  <span className="text-[11px] text-[var(--muted)]">{move.note}</span>
                </span>
                <span className={`text-[13px] font-semibold ${tone}`}>{usd(move.amountCents)}</span>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center gap-2">
          <button onClick={onOpenDetails} className="flex-1 rounded-full bg-[var(--primary)] py-2 text-[13px] font-medium text-white">
            View details
          </button>
          <button className="rounded-full px-3 py-2 text-[13px] text-[var(--muted)] hover:bg-[var(--canvas)]">Edit</button>
        </div>
      </div>
    </div>
  );
}

function Composer({ placeholder, onSend }: { placeholder: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="border-t border-[var(--line)] px-5 pb-3 pt-3">
      <div className="flex items-end gap-2 rounded-2xl bg-[var(--canvas)] px-4 py-2.5">
        <textarea
          name="message"
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="max-h-32 flex-1 resize-none bg-transparent text-[14px] outline-none placeholder:text-[var(--muted)]"
        />
      </div>
      <div className="mt-2 flex items-center gap-1 text-[var(--muted)]">
        <button title="Attach a vendor file" className="rounded-lg p-1.5 hover:bg-[var(--canvas)]">
          <Paperclip className="h-4 w-4" />
        </button>
        <button title="Add an item from a product link" className="rounded-lg p-1.5 hover:bg-[var(--canvas)]">
          <Link2 className="h-4 w-4" />
        </button>
        <button
          onClick={send}
          disabled={!text.trim()}
          title="Send"
          className="ml-auto rounded-full bg-[var(--primary)] p-2 text-white disabled:bg-[var(--line)]"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
