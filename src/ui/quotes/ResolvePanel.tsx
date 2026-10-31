"use client";

import { MessageCircleQuestion } from "lucide-react";
import type { OpeningLine } from "@/opening/types";

export interface ResolveItem {
  itemId: string;
  name: string;
  line: OpeningLine;
}

/**
 * The designer's list of V1 lines that are not agreed yet: declined lines with
 * the client's reason, and undecided lines with their questions in the chat.
 */
export function ResolvePanel({ items, onSelect, onDrop, onOpenChat, onRevise }: { items: ResolveItem[]; onSelect: (itemId: string) => void; onDrop: (itemId: string) => void; onOpenChat: () => void; onRevise: (item: ResolveItem) => void }) {
  const declined = items.filter((item) => item.line.state === "declined");
  const pending = items.filter((item) => item.line.state === "pending");
  return (
    <section aria-label="To resolve" className="mb-5 rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-[12px]">
      <h2 className="text-[13px] font-semibold text-amber-900">To resolve · {items.length} {items.length === 1 ? "line" : "lines"}</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-900/80">These lines are not part of the agreement. Revise a declined line by hand on the pricing page, or drop it. Lines the client has not decided on come along into the new version for a decision; withdraw one to leave it out.</p>
      <ul className="mt-3 divide-y divide-amber-100 rounded-lg bg-white">
        {[...declined, ...pending].map((item) => (
          <li key={item.itemId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
            <button onClick={() => onSelect(item.itemId)} className="font-medium hover:underline">{item.name}</button>
            <span className={item.line.state === "declined" ? "text-red-700" : "text-amber-800"}>{item.line.state === "declined" ? "Declined" : "Waiting for the client"}</span>
            {item.line.note && <span className="min-w-0 flex-1 truncate text-slate-600">&ldquo;{item.line.note}&rdquo;</span>}
            {item.line.questions > 0 && <button onClick={onOpenChat} className="flex items-center gap-1 text-[var(--primary)] hover:underline"><MessageCircleQuestion className="h-3.5 w-3.5" />{item.line.questions} in chat</button>}
            <span className="ml-auto flex gap-2">
              {item.line.state === "declined" && <button onClick={() => onRevise(item)} className="rounded-md bg-[var(--primary-fill)] px-2.5 py-1 font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">Revise</button>}
              <button onClick={() => onDrop(item.itemId)} className="rounded-md border border-[var(--line)] px-2.5 py-1 font-medium hover:bg-slate-50">{item.line.state === "declined" ? "Drop…" : "Withdraw…"}</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
