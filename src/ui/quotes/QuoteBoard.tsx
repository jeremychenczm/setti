"use client";

import { ArrowLeft, FileText, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import type { QuoteView, SignOpeningInput } from "@/opening/types";
import { QuoteReport, type QuoteActions } from "./QuoteReport";

type Loaded = { view: QuoteView } | { notShared: true } | { error: string };

async function post(path: string, body: unknown): Promise<{ ok: boolean; body: unknown }> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: response.ok, body: await response.json().catch(() => null) };
  } catch {
    return { ok: false, body: { error: "Connection interrupted. Retry: the same action is never recorded twice." } };
  }
}

const failure = (body: unknown, fallback: string) => (body as { error?: string } | null)?.error ?? fallback;

/**
 * Quotes for the designer, Proposals for a client. The server decides what the
 * signed-in account may see and do: a client gets a quote only once it was
 * sent, signs only their own project, and only the designer drops lines.
 * Remount it (key) to load another project or account.
 */
export function QuoteBoard({ projectKey, viewer, options, focusItemId, onBack, onSelectQuote, onOpenChat }: {
  projectKey: CaseKey; viewer: DemoAccount; options: CaseKey[]; focusItemId?: string | null;
  onBack: () => void; onSelectQuote: (id: CaseKey) => void; onOpenChat: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/quotes/${projectKey}`, { cache: "no-store", signal });
      const body = await response.json().catch(() => null);
      if (response.ok) setLoaded({ view: body as QuoteView });
      else if (body?.code === "NOT_SHARED") setLoaded({ notShared: true });
      else setLoaded({ error: body?.error ?? "The quote could not be loaded." });
    } catch {
      if (!signal?.aborted) setLoaded({ error: "Connection interrupted. Reload to try again." });
    }
  }, [projectKey]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const actions: QuoteActions = {
    async sign(input: SignOpeningInput) {
      const result = await post(`/api/quotes/${projectKey}/sign`, input);
      if (!result.ok) return failure(result.body, "The decisions could not be signed. Please retry.");
      setLoaded({ view: result.body as QuoteView });
      return null;
    },
    async drop(itemId: string) {
      const result = await post(`/api/quotes/${projectKey}/drop`, { itemId });
      if (!result.ok) return failure(result.body, "The line could not be dropped. Please retry.");
      setLoaded({ view: result.body as QuoteView });
      return null;
    },
    async revise(itemId: string) {
      const result = await post(`/api/quotes/${projectKey}/revise`, { itemId });
      if (!result.ok) return failure(result.body, "The line could not be revised. Please retry.");
      // The designer edits the revision on the pricing page, like any other draft.
      window.location.assign((result.body as { href: string }).href);
      return null;
    },
    async ask(itemId: string, text: string) {
      const result = await post(`/api/chat/${projectKey}`, { id: crypto.randomUUID(), actor: viewer.role, text, aboutItemId: itemId });
      if (!result.ok) return failure(result.body, "The question could not be sent. Please retry.");
      await load();
      return null;
    },
  };

  if (loaded && "view" in loaded) return <QuoteReport view={loaded.view} viewer={viewer} options={options} focusItemId={focusItemId} actions={actions} onBack={onBack} onSelectQuote={onSelectQuote} onOpenChat={onOpenChat} />;
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
