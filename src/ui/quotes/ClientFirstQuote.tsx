"use client";

import { LoaderCircle, PenLine, RotateCcw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { CaseKey } from "@/chat/types";
import { clientSignatureName, type OpeningLine, type QuoteView, type SignOpeningInput } from "@/opening/types";
import { calculateLineTotals } from "@/quotes/totals";
import { ProjectPayments } from "../payments/ProjectPayments";
import { dateTime, Field, inputClass, shortMoney } from "../pricing/common";
import { ReceiptDocument, type OpeningDecide } from "../receipts/ReceiptDocument";
import { useVersionReceipt } from "../receipts/useVersionReceipt";
import { EditorCrumbs } from "../pricing/EditorFrame";
import { ViewProjectInfo } from "./ViewProjectInfo";
import { useDemoMode } from "../demo-mode";
import { useCounted } from "../pricing/MoneyCard";

type Choice = { decision: "approved" | "declined"; note: string };
const today = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

function Tile({ label, cents, tone, caption }: { label: string; cents: number; tone: string; caption: string }) {
  const shown = useCounted(cents);
  return <div className="grid min-w-0 gap-0.5 rounded-[10px] bg-[var(--canvas)] px-3 py-2.5">
    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600"><i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: tone }} />{label}</span>
    <b className="text-[22px] font-bold leading-tight tracking-tight tabular-nums">{shortMoney(shown)}</b>
    <span className="text-[11px] leading-snug text-[var(--muted)]">{caption}</span>
  </div>;
}

/** V1's money by decision: approved services and products, declined, and still undecided. `choices` adds decisions not signed yet. */
export function firstQuoteMoney(quote: QuoteView["document"], lineOf: (itemId: string) => OpeningLine, choices: Readonly<Record<string, { decision: "approved" | "declined" }>> = {}) {
  const decisionOf = (itemId: string) => lineOf(itemId).state === "pending" ? choices[itemId]?.decision ?? "pending" : lineOf(itemId).state;
  const sum = (keep: (line: QuoteView["document"]["lines"][number]) => boolean) => quote.lines.filter(keep).reduce((total, line) => total + calculateLineTotals(line).totalCents, 0);
  const services = sum((line) => decisionOf(line.itemId) === "approved" && line.category === "service");
  const products = sum((line) => decisionOf(line.itemId) === "approved" && line.category !== "service");
  const declined = sum((line) => decisionOf(line.itemId) === "declined");
  const total = sum(() => true);
  return { services, products, declined, total, undecided: total - services - products - declined };
}

/** The money card at the top of V1's side column, for the client and the designer alike. */
export function FirstQuoteMoneyCard({ money, title, aside, services, products }: {
  money: ReturnType<typeof firstQuoteMoney>; title: string; aside: string;
  services: { label: string; caption: string }; products: { label: string; caption: string };
}) {
  const { services: serviceCents, products: productCents, declined, undecided, total } = money;
  const pct = (cents: number) => `${total ? (cents / total) * 100 : 0}%`;
  return <section className="grid gap-3 rounded-xl border border-[var(--line)] bg-white p-4" aria-label={title}>
    <div className="flex justify-between gap-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]"><span>{title}</span><span className="font-medium normal-case tracking-normal">{aside}</span></div>
    <div className="grid grid-cols-2 gap-2">
      <Tile label={services.label} cents={serviceCents} tone="#ffcc70" caption={services.caption} />
      <Tile label={products.label} cents={productCents} tone="#d7262e" caption={products.caption} />
    </div>
    <div className="flex h-2.5 overflow-hidden rounded-full bg-[#ebe9e2]" role="img" aria-label={`Of ${shortMoney(total)}: ${shortMoney(serviceCents + productCents)} approved, ${shortMoney(declined)} declined, ${shortMoney(undecided)} undecided`}>
      <i className="block h-full transition-[width] duration-500" style={{ width: pct(serviceCents), background: "#ffcc70" }} /><i className="block h-full transition-[width] duration-500" style={{ width: pct(productCents), background: "#d7262e" }} /><i className="block h-full transition-[width] duration-500" style={{ width: pct(declined), background: "#bdb8a8" }} />
    </div>
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--muted)]"><span>Approved <b className="text-[var(--ink)]">{shortMoney(serviceCents + productCents)}</b></span><span>Declined <b className="text-[var(--ink)]">{shortMoney(declined)}</b></span><span>Undecided <b className="text-[var(--ink)]">{shortMoney(undecided)}</b></span></p>
    <p className="text-[11.5px] text-[var(--muted)]">A hold is charged only when the supplier confirms the order.</p>
  </section>;
}

/**
 * The client's V1 in Proposals, laid out like every later version: the formal
 * quote beside the money and the decision. On an open V1 the client approves or
 * declines each undecided line on the quote itself, a decline with its reason,
 * then signs those decisions in a card of their own; lines left undecided stay
 * open for later. After signing, the decision reads as a record and the
 * payments it starts follow below the quote.
 */
export function ClientFirstQuote({ projectKey, view, studioName, toolbar, onSign, onOpenChat }: {
  projectKey: CaseKey; view: QuoteView; studioName: string; toolbar?: ReactNode;
  onSign: (input: SignOpeningInput) => Promise<string | null>; onOpenChat: () => void;
}) {
  const demo = useDemoMode();
  const { document: quote, opening, approval } = view;
  const clientName = clientSignatureName(quote);
  const lineOf = (itemId: string): OpeningLine => view.lines[itemId] ?? { state: approval ? "approved" : "pending", note: null, decidedAt: null, by: null, questions: 0 };
  const open = !approval && !!opening.sentAt && !opening.closed;
  const pending = quote.lines.filter((line) => lineOf(line.itemId).state === "pending");
  const deciding = open && pending.length > 0;
  const formal = useVersionReceipt(projectKey, 1, { refresh: `${opening.progress.approved}:${opening.progress.declined}:${opening.signedAt ?? ""}` });

  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // The lines "Approve all" set, so Undo puts back exactly those.
  const [lastAll, setLastAll] = useState<string[] | null>(null);
  const [signature, setSignature] = useState(demo ? clientName : "");
  const [acknowledged, setAcknowledged] = useState(demo);
  const [signingId, setSigningId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const decide = useMemo<OpeningDecide | undefined>(() => deciding ? {
    choices,
    onChoose: (itemId, decision) => { setNotice(null); setChoices((current) => { const next = { ...current }; if (decision) next[itemId] = { decision, note: current[itemId]?.note ?? "" }; else delete next[itemId]; return next; }); },
    onReason: (itemId, note) => setChoices((current) => current[itemId] ? { ...current, [itemId]: { ...current[itemId], note } } : current),
  } : undefined, [deciding, choices]);

  const money = firstQuoteMoney(quote, lineOf, choices);

  const chosen = pending.filter((line) => choices[line.itemId]);
  const toApprove = chosen.filter((line) => choices[line.itemId].decision === "approved").length;
  const missing = chosen.filter((line) => choices[line.itemId].decision === "declined" && !choices[line.itemId].note.trim()).map((line) => line.name);
  const ready = chosen.length > 0 && !missing.length && acknowledged && signature.trim() === clientName && !busy;

  function approveAll() {
    const ids = pending.filter((line) => !choices[line.itemId]).map((line) => line.itemId);
    setChoices((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, { decision: "approved" as const, note: "" }])) }));
    setLastAll(ids); setNotice(null);
  }
  function undoAll() {
    // Only the lines Approve all set and that are still approved go back to undecided.
    setChoices((current) => Object.fromEntries(Object.entries(current).filter(([id, choice]) => !(lastAll?.includes(id) && choice.decision === "approved"))));
    setLastAll(null);
  }
  async function sign() {
    if (!ready || !opening.contentHash) return;
    setBusy(true); setError(null);
    const decisions = chosen.map((line) => {
      const choice = choices[line.itemId];
      return choice.decision === "declined" ? { itemId: line.itemId, decision: choice.decision, note: choice.note.trim() } : { itemId: line.itemId, decision: choice.decision };
    });
    const failure = await onSign({ signingId, contentHash: opening.contentHash, signature: signature.trim(), acknowledged: true, decisions });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setChoices({}); setLastAll(null); setSigningId(crypto.randomUUID());
    setNotice("Signed. Your designer sees your decisions in the project chat.");
  }

  const card = "rounded-xl border border-[var(--line)] bg-white";
  const fact = (label: string, value: ReactNode) => <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] py-2.5 text-[12.5px]"><dt className="text-[var(--muted)]">{label}</dt><dd className="m-0 text-right font-semibold">{value}</dd></div>;
  const signed = approval ? { at: approval.approvedAt, by: approval.approvedBy, sample: true } : opening.signedAt ? { at: opening.signedAt, by: clientName, sample: false } : null;

  return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl" aria-label="Quote version 1">
    <div className="grid gap-3 pb-2 text-[var(--ink)]">
      <EditorCrumbs section="Proposals" name={quote.projectName} right={toolbar} />
      <ViewProjectInfo projectKey={projectKey} client={true} studioName={studioName} designerName={quote.designerName} clientName={clientName} projectName={quote.projectName} version={1} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4 lg:sticky lg:top-0 lg:col-start-2 lg:row-start-1">
          <FirstQuoteMoneyCard money={money} title="Your money" aside={deciding ? "If you sign these decisions" : "For the lines you approved"}
            services={deciding ? { label: "Pay when you sign", caption: "Services you approve" } : { label: "Services", caption: "Paid in the payment steps below" }}
            products={deciding ? { label: "Held on your card", caption: "Products you approve" } : { label: "Products", caption: "Held, charged as each supplier confirms" }} />

          {deciding && <>
            <section className={`${card} grid gap-3 p-5`} aria-labelledby="client-decision-title">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="client-decision-title" className="text-[15px] font-bold">Your decision on V1</h2>
                {lastAll?.length ? <button type="button" onClick={undoAll} title={`Set the ${lastAll.length} lines Approve all changed back to undecided`} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-[#1f241d]"><RotateCcw className="h-3 w-3" />Undo</button>
                  : <button type="button" onClick={approveAll} disabled={pending.every((line) => choices[line.itemId])} title="Approve every undecided line" className="rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-[#1f241d] disabled:bg-slate-200 disabled:text-slate-400">Approve all</button>}</div>
              <p className="text-[12.5px] text-slate-600">Approve or decline each line on the quote. Undecided lines can wait.</p>
              <div className="grid grid-cols-3 gap-2">{([["Approve", toApprove], ["Decline", chosen.length - toApprove], ["Undecided", pending.length - chosen.length]] as const).map(([label, count]) =>
                <div key={label} className="grid rounded-lg bg-[var(--canvas)] px-2.5 py-2"><span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--muted)]">{label}</span><b className="text-[15px]">{count}</b></div>)}</div>
              {missing.length > 0 && <p className="text-[11.5px] text-red-700">Add a reason for declining: {missing.join(", ")}.</p>}
            </section>
            <section className={`${card} grid gap-3 p-5`} aria-label="Sign V1">
              <h3 className="text-[15px] font-bold">Sign V1</h3>
              <p className="-mt-1.5 text-[11.5px] text-[var(--muted)]">{chosen.length ? `Covers ${toApprove} ${toApprove === 1 ? "approval" : "approvals"}${chosen.length - toApprove ? ` and ${chosen.length - toApprove} ${chosen.length - toApprove === 1 ? "decline" : "declines"}` : ""}.${pending.length - chosen.length ? ` ${pending.length - chosen.length} ${pending.length - chosen.length === 1 ? "line stays" : "lines stay"} open.` : ""}` : "Approve or decline at least one line first."}</p>
              <fieldset disabled={busy} className="grid gap-3">
                <label className="flex cursor-pointer items-start gap-2 text-[12px] text-slate-600"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5 accent-emerald-700" /><span>I have read my decisions on V1.</span></label>
                <Field label="Type your full name" hint={`Type it exactly: ${clientName}`}><input aria-label="Your signature" autoComplete="off" value={signature} onChange={(event) => setSignature(event.target.value)} maxLength={160} className={inputClass} /></Field>
                <div aria-hidden className="flex min-h-[60px] items-end gap-2.5 border-b-[1.5px] border-[var(--ink)] px-0.5 pb-1"><span className="pb-1.5 text-[18px] text-[var(--muted)]">×</span><span className="truncate font-signature text-[34px] leading-none">{signature.trim()}</span></div>
                <div className="-mt-1.5 flex justify-between gap-3 text-[11px] text-[var(--muted)]"><span>{clientName} · Client</span><span>{today()} · V1</span></div>
                <div className="flex justify-end"><button type="button" onClick={() => void sign()} disabled={!ready} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PenLine className="h-3.5 w-3.5" />}Sign V1</button></div>
              </fieldset>
              {error && <p role="alert" className="text-[12px] text-red-700">{error}</p>}
            </section>
          </>}

          {signed && <section className={`${card} p-5`} aria-labelledby={deciding ? undefined : "client-decision-title"}>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]">{signed.sample ? "Approved" : "Signed"} · {dateTime(signed.at)} PT</p>
            <h2 id={deciding ? undefined : "client-decision-title"} className="mt-0.5 text-[15px] font-bold">{deciding ? "Your earlier signature on V1" : "V1 signed"}</h2>
            <dl className="mt-3 border-t border-[var(--line)]">
              {fact("Approved", `${opening.progress.approved || (approval ? quote.lines.length : 0)} of ${quote.lines.length} lines`)}
              {opening.progress.declined > 0 && fact("Declined", `${opening.progress.declined} ${opening.progress.declined === 1 ? "line" : "lines"}`)}
              {opening.progress.pending > 0 && !approval && fact("Still open", `${opening.progress.pending} ${opening.progress.pending === 1 ? "line" : "lines"}`)}
              {fact("Signed as", <span className="font-signature text-[20px] font-normal leading-none">{signed.by.replace(/\s*\(demo signature\)$/, "")}</span>)}
              {signed.sample && fact("Note", <span className="font-normal text-slate-600">A sample approval that came with the demo</span>)}
            </dl>
            <div className="mt-3 flex justify-end"><button type="button" onClick={onOpenChat} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]">Open the project chat</button></div>
          </section>}
          {notice && <p role="status" className="rounded-lg bg-brand-50 p-3 text-[12px] text-brand-900">{notice}</p>}
          {opening.closed && <p className="rounded-lg bg-[var(--canvas)] p-3 text-[12px] text-slate-600">A newer version replaced V1. Its approved lines carried over as that version&apos;s starting point.</p>}
        </div>
        <div className="min-w-0 rounded-xl bg-[#8e8c85] p-3 sm:p-[18px] lg:col-start-1 lg:row-start-1">
          {!formal && <p role="status" className="flex items-center gap-2 rounded-lg bg-white/90 p-6 text-[13px] text-slate-600"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the formal quote…</p>}
          {formal && "error" in formal && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{formal.error}</p>}
          {formal && "receipt" in formal && <ReceiptDocument receipt={formal.receipt} studioName={studioName} embedded decide={formal.stale ? undefined : decide} updating={formal.stale} />}
        </div>
      </div>
      {open && opening.progress.approved > 0 && <ProjectPayments projectKey={projectKey} orderId={null} onServicesPaid={onOpenChat} />}
    </div>
  </section>;
}
