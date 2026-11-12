"use client";

import { LoaderCircle } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey, CaseSnapshot, SentVersion } from "@/chat/types";
import { QuoteBoard } from "./QuoteBoard";
import type { QuoteOption } from "./QuoteReport";

const loading = () => <section className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-white text-[12px] text-[var(--muted)] shadow-sm"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Loading the quote…</section>;
const PricingWorkspaceView = dynamic(() => import("../pricing/PricingWorkspaceView").then((m) => m.PricingWorkspaceView), { loading });
const ChangeOrderPage = dynamic(() => import("../pricing/ChangeOrderPage").then((m) => m.ChangeOrderPage), { loading });

interface Versions { sent: SentVersion[]; draftOpen: boolean }

/**
 * A project's Quotes, for the designer, or Proposals, for its client. One page
 * for every version: the designer edits the open draft here, and every sent
 * version opens here too, with its decision and payments. `version` picks one;
 * without it the page opens on the draft being edited, else the newest version.
 */
export function QuotesModule({ projectKey, studioName, clientName, viewer, demo, options, focusItemId, version: requested, onBack, onSelectQuote, onOpenChat }: {
  projectKey: CaseKey; studioName: string; clientName: string; viewer: DemoAccount; demo: boolean; options: QuoteOption[]; focusItemId?: string | null; version?: number | null;
  onBack: () => void; onSelectQuote: (id: CaseKey) => void; onOpenChat: () => void;
}) {
  const [versions, setVersions] = useState<Versions | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chat/${encodeURIComponent(projectKey)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<CaseSnapshot> : null)
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        const sent = [...(snapshot?.versions ?? [])].sort((a, b) => b.version - a.version);
        // A draft is open until a version was sent from it as it stands.
        setVersions({ sent, draftOpen: !!snapshot?.draft && !sent.some((entry) => entry.fromCurrentDraft) });
      })
      .catch(() => { if (!controller.signal.aborted) setVersions({ sent: [], draftOpen: false }); });
    return () => controller.abort();
  }, [projectKey]);

  if (!versions) return loading();
  const board = <QuoteBoard projectKey={projectKey} studioName={studioName} viewer={viewer} options={options} focusItemId={focusItemId} onBack={onBack} onSelectQuote={onSelectQuote} onOpenChat={onOpenChat} />;
  // A version number names a sent version; V1 stays on the quote board, which knows its line decisions.
  if (requested === 1) return board;
  const chosen = requested ? versions.sent.find((entry) => entry.version === requested) : undefined;
  if (!chosen && viewer.role === "designer" && versions.draftOpen) {
    return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label="Quote editor"><PricingWorkspaceView projectKey={projectKey} clientName={clientName} embedded /></section>;
  }
  const shown = chosen ?? versions.sent[0];
  if (shown) return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label={`Quote version ${shown.version}`}><ChangeOrderPage orderId={shown.id} account={viewer} demo={demo} studioName={studioName} embedded /></section>;
  return board;
}
