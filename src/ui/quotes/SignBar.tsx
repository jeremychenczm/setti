"use client";

import { ArrowRight, LoaderCircle, LockKeyhole, PenLine, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usd } from "../demo-data";

/**
 * The client's decisions for the open quote, fixed at the bottom of the page.
 * The bar sums up the choices made so far; signing happens in a drawer that
 * shows what is signed. Ticked lines are set together in a row of the table.
 * One signature covers every chosen line; undecided lines stay open for later.
 */
export function SignBar({ clientName, version, approveCount, approveCents, declineCount, undecided, missingReasons, onSign }: {
  clientName: string;
  version: number;
  approveCount: number;
  approveCents: number;
  declineCount: number;
  /** Lines with no choice yet, which this signature leaves open. */
  undecided: number;
  /** Declined lines that still need a reason. */
  missingReasons: string[];
  /** Returns an error to show, or null once signed. */
  onSign: (signature: string) => Promise<string | null>;
}) {
  const [signingOpen, setSigningOpen] = useState(false);
  const chosen = approveCount + declineCount;
  const canReview = chosen > 0 && !missingReasons.length;

  return (
    <div aria-label="Sign your decisions" className="shrink-0 border-t border-[var(--line)] bg-white px-5 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] lg:px-9">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
        <Tally dot="bg-emerald-500" label={`${approveCount} to approve`} value={approveCount ? usd(approveCents) : undefined} />
        <Tally dot="bg-red-500" label={`${declineCount} to decline`} />
        <Tally dot="border border-slate-400 bg-white" label={`${undecided} undecided`} />
        <button onClick={() => setSigningOpen(true)} disabled={!canReview}
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-[var(--primary-fill)] px-5 py-2.5 text-[13px] font-semibold text-[var(--on-primary)] shadow-sm hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none">
          <PenLine className="h-4 w-4" />Review &amp; sign{chosen ? ` (${chosen})` : ""}<ArrowRight className="h-4 w-4" />
        </button>
      </div>
      {missingReasons.length > 0 && <p className="mt-1.5 text-[11px] text-red-700">Add a reason for declining: {missingReasons.join(", ")}.</p>}
      {signingOpen && <SignDrawer clientName={clientName} version={version} approveCount={approveCount} approveCents={approveCents} declineCount={declineCount} undecided={undecided} onSign={onSign} onClose={() => setSigningOpen(false)} />}
    </div>
  );
}

function Tally({ dot, label, value }: { dot: string; label: string; value?: string }) {
  return <span className="inline-flex items-center gap-2 text-slate-700">
    <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
    <span>{label}{value && <span className="ml-1.5 font-semibold tabular-nums text-[var(--ink)]">{value}</span>}</span>
  </span>;
}

const today = () => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }).format(new Date());

/**
 * Shows what the signature covers before it is given. The demo fills in the
 * client's name and ticks the review so a test signature is one click; both
 * can still be changed.
 */
function SignDrawer({ clientName, version, approveCount, approveCents, declineCount, undecided, onSign, onClose }: {
  clientName: string; version: number; approveCount: number; approveCents: number; declineCount: number; undecided: number;
  onSign: (signature: string) => Promise<string | null>; onClose: () => void;
}) {
  const [signature, setSignature] = useState(clientName);
  const [acknowledged, setAcknowledged] = useState(true);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = approveCount + declineCount;
  const nameMatches = signature.trim() === clientName;
  const ready = chosen > 0 && acknowledged && nameMatches && !signing;
  const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !signing) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose, signing]);

  async function sign() {
    if (!ready) return;
    setSigning(true);
    setError(null);
    const failure = await onSign(signature.trim());
    if (failure) { setError(failure); setSigning(false); }
    else onClose();
  }

  return <>
    {/* A click beside the drawer closes it. */}
    <div aria-hidden className="fixed inset-0 z-30 bg-slate-900/15" onClick={signing ? undefined : onClose} />
    <aside role="dialog" aria-modal="true" aria-labelledby="sign-quote-title" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-[var(--line)] bg-white shadow-2xl">
      <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="sign-quote-title" className="text-[15px] font-semibold leading-snug">Sign quote V{version}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">Your decisions apply to this locked version.</p>
        </div>
        <button onClick={onClose} disabled={signing} aria-label="Close signing" className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[12px]">
        <section aria-labelledby="sign-summary-title">
          <h3 id="sign-summary-title" className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">What you are signing</h3>
          <dl className="mt-1.5 divide-y divide-[var(--line)]">
            <SummaryRow dot="bg-emerald-500" label={`Approve ${lines(approveCount)}`} value={usd(approveCents)} strong />
            <SummaryRow dot="bg-red-500" label={`Decline ${lines(declineCount)}`} value={declineCount ? "With your reasons" : "None"} />
            <SummaryRow dot="border border-slate-400 bg-white" label={`Leave ${lines(undecided)} open`} value={undecided ? "Sign them later" : "None"} />
          </dl>
        </section>
        <section aria-labelledby="sign-name-title">
          <h3 id="sign-name-title" className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Your signature</h3>
          <input aria-label="Client signature" value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={160} autoComplete="off"
            className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[13px] outline-none focus:border-brand-400" />
          {!nameMatches && <p className="mt-1 text-[11px] text-amber-800">Type your full name as it appears on the quote: {clientName}.</p>}
          <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--canvas)] px-4 pb-3 pt-5">
            <div aria-hidden className="min-h-[46px] truncate border-b border-slate-300 pb-1 font-signature text-[32px] leading-none text-[var(--ink)]">{signature.trim()}</div>
            <div className="mt-1.5 flex justify-between gap-3 text-[10px] text-[var(--muted)]"><span>{clientName} · Client</span><span>{today()} · Quote V{version}</span></div>
          </div>
        </section>
        <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-slate-700">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" />
          I reviewed the lines I am deciding, with their prices and terms. Each decision applies to this locked V{version} and cannot be changed afterwards.
        </label>
        {error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
      </div>
      <footer className="border-t border-[var(--line)] px-5 py-4">
        <button onClick={() => void sign()} disabled={!ready} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2.5 text-[13px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:opacity-50">
          {signing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}Sign {chosen} {chosen === 1 ? "decision" : "decisions"}
        </button>
        <p className="mt-2 flex items-center justify-center gap-1 text-[11px] text-[var(--muted)]"><LockKeyhole className="h-3 w-3" />Nothing is charged by signing.</p>
      </footer>
    </aside>
  </>;
}

function SummaryRow({ dot, label, value, strong = false }: { dot: string; label: string; value: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-3 py-2">
    <dt className="inline-flex items-center gap-2 text-slate-700"><span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />{label}</dt>
    <dd className={`tabular-nums ${strong ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}>{value}</dd>
  </div>;
}
