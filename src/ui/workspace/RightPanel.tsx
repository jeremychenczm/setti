"use client";

import { ArrowLeft, Download, FileText, ShieldCheck, Upload, Wallet } from "lucide-react";
import { useState } from "react";
import type { Agent, Conversation, Item } from "../demo-data";
import { usd } from "../demo-data";
import { StateChip } from "./primitives";

export type PanelTab = "items" | "money" | "files";

export function RightPanel({ conversation, tab, onTab, onOpenQuote }: { conversation: Conversation; tab: PanelTab; onTab: (t: PanelTab) => void; onOpenQuote?: () => void }) {
  if (conversation.kind === "agent") return <AgentAbout agent={conversation.counterpart as Agent} />;

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "items", label: "Items" },
    { id: "money", label: "Money" },
    { id: "files", label: "Files" },
  ];

  return (
    <aside className="flex w-[340px] shrink-0 flex-col rounded-xl bg-white shadow-sm">
      <div className="flex gap-1 border-b border-[var(--line)] px-3 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className={`border-b-2 px-3 py-2.5 text-[13px] ${tab === t.id ? "border-[var(--primary)] font-semibold" : "border-transparent text-[var(--muted)]"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {conversation.id === "maple" && onOpenQuote && (
        <div className="border-b border-[var(--line)] px-4 py-2.5">
          <button onClick={onOpenQuote} className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--primary)] hover:underline">
            <FileText className="h-3.5 w-3.5" />
            View approved quote
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "items" && <ItemsTab key={conversation.id} items={conversation.items} />}
        {tab === "money" && <MoneyTab conversation={conversation} />}
        {tab === "files" && <FilesTab conversation={conversation} />}
      </div>
    </aside>
  );
}

function ItemsTab({ items }: { items: Item[] }) {
  const [open, setOpen] = useState<Item | null>(null);
  if (open) return <ItemTimeline item={open} onBack={() => setOpen(null)} />;
  if (items.length === 0) return <Empty title="No items yet" text="Paste a product link or attach a quote in the chat." />;

  return (
    <ul className="p-2">
      {items.map((item) => (
        <li key={item.id}>
          <button onClick={() => setOpen(item)} className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-[var(--canvas)]">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{item.name}</span>
              <StateChip state={item.state} />
              <span className="ml-auto text-[13px] font-semibold">{usd(item.priceCents)}</span>
            </span>
            <span className="mt-0.5 block text-[12px] text-[var(--muted)]">
              {item.vendor} · {item.detail}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ItemTimeline({ item, onBack }: { item: Item; onBack: () => void }) {
  return (
    <div className="p-4">
      <button onClick={onBack} className="mb-3 flex items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]">
        <ArrowLeft className="h-3.5 w-3.5" />
        Items
      </button>
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold">{item.name}</h3>
        <StateChip state={item.state} />
      </div>
      <div className="mt-0.5 text-[12px] text-[var(--muted)]">
        {item.vendor} · {usd(item.priceCents)}
      </div>

      <ol className="mt-4 space-y-3 border-l border-[var(--line)] pl-4">
        {item.timeline.map((entry, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-[var(--primary)] ring-4 ring-white" />
            <div className="text-[11px] text-[var(--muted)]">
              {entry.at} · {entry.actor}
            </div>
            <div className="text-[13px] leading-snug">{entry.text}</div>
            {entry.ref && (
              <span className="mt-1 inline-block rounded bg-[var(--canvas)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">{entry.ref}</span>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-5 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
        <ShieldCheck className="h-4 w-4" />
        Record intact · {item.timeline.length} entries
        <button className="ml-auto flex items-center gap-1 font-medium hover:underline">
          <Download className="h-3.5 w-3.5" />
          Evidence
        </button>
      </div>
    </div>
  );
}

function MoneyTab({ conversation }: { conversation: Conversation }) {
  const money = conversation.money;
  if (!money) return null;
  const tiles = [
    { label: "Collected", value: money.collectedCents },
    { label: "On hold", value: money.onHoldCents },
    { label: "Refunds owed", value: money.refundsPromisedCents },
  ];

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-[var(--line)] p-3">
        <div className="text-[12px] text-[var(--muted)]">Approved budget</div>
        <div className="mt-0.5 text-[22px] font-semibold">{usd(money.approvedCents)}</div>
        {money.proposedCents !== undefined && (
          <div className="mt-1 text-[12px] text-amber-700">
            {usd(money.proposedCents)} proposed in the change waiting for {conversation.counterpart.name.split(" ")[0]}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-[var(--canvas)] px-2.5 py-2">
            <div className="text-[11px] text-[var(--muted)]">{t.label}</div>
            <div className="text-[14px] font-semibold">{usd(t.value)}</div>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[var(--line)] px-3 py-2.5 text-[12px]">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)]" />
        <span>
          {money.vault}
          <span className="block text-[var(--muted)]">Only for approved changes in this project</span>
        </span>
      </div>

      <div className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        Matches PayPal · checked by Money Agent at 3:42 PM
      </div>
    </div>
  );
}

function FilesTab({ conversation }: { conversation: Conversation }) {
  return (
    <div className="p-2">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[12px] text-[var(--muted)]">Read by Vendor Docs</span>
        <button className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--primary)] hover:bg-[var(--primary-soft)]">
          <Upload className="h-3.5 w-3.5" />
          Upload
        </button>
      </div>
      {conversation.files.length === 0 ? (
        <Empty title="No vendor files" text="Quotes, return terms and surcharge notices you add show up here." />
      ) : (
        <ul>
          {conversation.files.map((f) => (
            <li key={f.id} className="flex gap-2.5 rounded-lg px-2 py-2.5 hover:bg-[var(--canvas)]">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{f.name}</span>
                <span className="block text-[12px] text-[var(--muted)]">
                  {f.kind} · {f.summary}
                </span>
                <span className="text-[11px] text-[var(--muted)]">Added {f.added}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentAbout({ agent }: { agent: Agent }) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col rounded-xl bg-white p-5 shadow-sm">
      <div className="text-[13px] font-semibold">About {agent.name}</div>
      <p className="mt-1 text-[13px] text-[var(--muted)]">{agent.blurb}</p>
      <div className="mt-5 text-[12px] font-medium text-[var(--muted)]">What it does</div>
      <ul className="mt-2 space-y-2">
        {agent.can.map((line) => (
          <li key={line} className="text-[13px] leading-snug">
            {line}
          </li>
        ))}
      </ul>
      <div className="mt-5 text-[12px] font-medium text-[var(--muted)]">Limits</div>
      <ul className="mt-2 space-y-2 text-[13px] leading-snug">
        <li>Reads PayPal, never moves money</li>
        <li>Drafts and explains; you approve and send</li>
        <li>Sees only the projects it is added to</li>
      </ul>
    </aside>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <div className="text-[14px] font-semibold text-[var(--muted)]">{title}</div>
      <p className="mt-1 text-[12px] text-[var(--muted)]">{text}</p>
    </div>
  );
}
