"use client";

import { ArrowLeft, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import type { QuoteView } from "@/opening/types";
import { QuoteReport } from "./QuoteReport";

type Loaded = { view: QuoteView } | { notShared: true } | { error: string };

/**
 * Quotes for the designer, Proposals for a client. The server decides what the
 * signed-in account may see: a client gets a quote only once it was sent.
 * Remount it (key) to load another project or account.
 */
export function QuoteBoard({ projectKey, viewer, options, onBack, onSelectQuote }: { projectKey: CaseKey; viewer: DemoAccount; options: CaseKey[]; onBack: () => void; onSelectQuote: (id: CaseKey) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/quotes/${projectKey}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (response.ok) setLoaded({ view: body as QuoteView });
        else if (body?.code === "NOT_SHARED") setLoaded({ notShared: true });
        else setLoaded({ error: body?.error ?? "The quote could not be loaded." });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ error: "Connection interrupted. Reload to try again." }); });
    return () => controller.abort();
  }, [projectKey]);

  if (loaded && "view" in loaded) return <QuoteReport view={loaded.view} options={options} onBack={onBack} onSelectQuote={onSelectQuote} />;
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-sm">
      <header className="flex items-center gap-3 border-b border-[var(--line)] px-6 py-3.5"><button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" />Back to chats</button></header>
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        {!loaded && <span role="status" className="flex items-center gap-2 text-[12px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading quote…</span>}
        {loaded && "notShared" in loaded && <div className="max-w-sm"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-[var(--primary)]"><FileText className="h-6 w-6" strokeWidth={1.5} /></span><h1 className="mt-4 text-[17px] font-semibold">No proposals yet</h1><p className="mt-2 text-[13px] leading-relaxed text-slate-500">Quotes from the studio appear here once they are sent to {viewer.name}. Nothing has been sent for this project yet.</p></div>}
        {loaded && "error" in loaded && <p role="alert" className="max-w-sm rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] text-red-800">{loaded.error}</p>}
      </div>
    </section>
  );
}
