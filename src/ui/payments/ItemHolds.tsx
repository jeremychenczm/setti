"use client";

import { Armchair, CheckCircle2, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ItemHoldView, ItemHoldsView } from "@/payments/item-holds-view";
import { dateTime, money } from "../pricing/common";

async function request(key: CaseKey, hold: boolean): Promise<ItemHoldsView> {
  const response = await fetch(`/api/quotes/${key}/item-holds`, {
    cache: "no-store",
    ...(hold ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "hold" }) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = json as { error?: string; details?: string[] } | null;
    throw new Error([failure?.error ?? `Request failed (${response.status}).`, ...(failure?.details ?? [])].join(" "));
  }
  return hold ? (json as { view: ItemHoldsView }).view : json as ItemHoldsView;
}

/**
 * The approved furniture of the project's current agreement, each with its own
 * PayPal hold placed with the client's saved PayPal. Holding runs on its own
 * whenever `holdRequest` changes (after the design services are paid) and from
 * the button, which also retries items whose hold failed.
 */
export function ItemHolds({ projectKey, orderId, holdRequest }: { projectKey: CaseKey; orderId: string | null; holdRequest: number }) {
  const [view, setView] = useState<ItemHoldsView | null>(null);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(0);

  const load = useCallback(async () => {
    try { setView(await request(projectKey, false)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The item holds could not be loaded."); }
  }, [projectKey]);
  useEffect(() => { void load(); }, [load]);

  const hold = useCallback(async () => {
    setHolding(true); setError(null);
    try { setView(await request(projectKey, true)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Holding did not finish. Reload to see what PayPal recorded."); void load(); }
    finally { setHolding(false); }
  }, [projectKey, load]);
  useEffect(() => {
    if (holdRequest > handled.current) { handled.current = holdRequest; void hold(); }
  }, [holdRequest, hold]);

  if (!view?.basis || view.basis.orderId !== orderId || !view.items.length) return null;
  const covered = view.items.filter((line) => line.state === "held" || line.state === "captured").length;
  const failed = view.items.filter((line) => line.state === "failed").length;

  return <section id="item-holds" aria-labelledby="item-holds-title" className="mt-6 rounded-xl border border-[var(--line)] bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-50 text-blue-700"><Armchair className="h-4 w-4" /></span>
      <div className="mr-auto"><h2 id="item-holds-title" className="text-[13px] font-semibold">Approved items · V{view.basis.version}</h2><p className="text-[11px] text-[var(--muted)]">Each item gets its own PayPal hold with the PayPal the client saved, no checkout</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${covered === view.items.length ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{covered} of {view.items.length} held</span>
    </div>
    <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">A hold reserves the item&apos;s amount on the client&apos;s PayPal. Nothing is charged until the supplier confirms the item; a hold lasts up to 29 days.</p>
    <div className="mt-3 max-h-[420px] overflow-y-auto"><table className="w-full border-collapse text-[12px]"><tbody>{view.items.map((line) => <ItemRow key={line.itemId} line={line} />)}</tbody></table></div>
    {view.canHold && view.toHoldCents > 0 && <button type="button" disabled={holding} onClick={() => void hold()}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50">{holding ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LockKeyhole className="h-3.5 w-3.5" />}{failed ? "Retry the items that were not held" : `Hold ${money(view.toHoldCents)} with saved PayPal`}</button>}
    {holding && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]"><LoaderCircle className="h-3 w-3 animate-spin" />Holding each approved item on PayPal…</p>}
    {view.reason && !holding && <p className="mt-3 text-[11px] text-[var(--muted)]">{view.reason}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
  </section>;
}

function ItemRow({ line }: { line: ItemHoldView }) {
  const status = {
    captured: <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Captured</span>,
    held: <span className="inline-flex items-center gap-1 text-blue-700"><LockKeyhole className="h-3.5 w-3.5" />Held{line.expiresAt ? ` · until ${dateTime(line.expiresAt)}` : ""}</span>,
    holding: <span className="inline-flex items-center gap-1 text-[var(--muted)]"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Holding</span>,
    failed: <span className="inline-flex items-center gap-1 text-amber-800" title={line.failureMessage ?? undefined}><TriangleAlert className="h-3.5 w-3.5" />Not held</span>,
    to_hold: <span className="text-[var(--muted)]">To hold</span>,
  }[line.state];
  return <tr className="border-t border-[var(--line)] first:border-t-0">
    <td className="py-2 pr-3">{line.label}{line.state === "failed" && line.failureMessage && <p className="mt-0.5 text-[10px] text-amber-800">{line.failureMessage}</p>}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{money(line.targetCents)}</td>
    <td className="w-[220px] py-2 text-right text-[11px]">{status}</td>
  </tr>;
}
