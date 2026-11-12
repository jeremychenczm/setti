"use client";

import { ArrowLeft, Download, LoaderCircle, Printer } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { notRefundedText } from "@/pricing/fees";
import type { ReceiptItem, VersionReceipt } from "@/receipts/types";
import {
  ACTION_LABELS, CHANGE_LABELS, DECISION_LABELS, HANDLING_LABELS, PENDING_LABELS, TIMING_LABELS, VIA_LABELS,
  certificateRows, paymentGroups, paypalReference, pendingRows, ptDateTime, ptDay, sealOf, shortHash, signedUsd, usd, utcTime, verifyCommand, type Seal,
} from "./receipt-view";
import { useDemoMode } from "../demo-mode";

type Loaded = { receipt: VersionReceipt } | { error: string };

/**
 * A signed version receipt laid out as a document: letterhead, numbered
 * sections, ruled tables and a signature certificate. On paper it prints as
 * Letter pages with the receipt number and page count in the footer.
 */
export function ReceiptPage({ projectKey, version, studioName }: { projectKey: string; version: string; studioName: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const source = `/api/receipts/${encodeURIComponent(projectKey)}/${encodeURIComponent(version)}`;

  useEffect(() => {
    const controller = new AbortController();
    fetch(source, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        setLoaded(response.ok ? { receipt: body as VersionReceipt } : { error: body?.error ?? "This receipt could not be loaded." });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ error: "Connection interrupted. Reload to try again." }); });
    return () => controller.abort();
  }, [source]);

  const receipt = loaded && "receipt" in loaded ? loaded.receipt : null;
  return <div className="min-h-dvh bg-[#e7e5de] px-3 py-5 text-[var(--ink)] sm:px-6 print:min-h-0 print:bg-white print:p-0">
    <main className="mx-auto grid max-w-[816px] gap-4 print:max-w-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[#d6d3c8] bg-[#fbfaf7] px-3 py-2 print:hidden">
        <a href={`/chats/${projectKey}`} className="flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" />Back to project chat</a>
        {receipt && <span className="font-mono text-[11px] text-[var(--muted)]">No. {receipt.receiptNo}</span>}
        {receipt && <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg border border-[#d6d3c8] bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]"><Printer className="h-3.5 w-3.5" />Print or save as PDF</button>
          <a href={`${source}?download=1`} className="flex items-center gap-1.5 rounded-lg border border-[#d6d3c8] bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]"><Download className="h-3.5 w-3.5" />Download record (JSON)</a>
        </div>}
      </div>
      {!loaded && <p role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the receipt…</p>}
      {loaded && "error" in loaded && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{loaded.error}</p>}
      {receipt && <><PrintRules receiptNo={receipt.receiptNo} /><ReceiptDocument receipt={receipt} studioName={studioName} /></>}
    </main>
  </div>;
}

/** Letter pages, with the receipt number and page count printed in the bottom margin of every page. */
function PrintRules({ receiptNo }: { receiptNo: string }) {
  const number = /^[A-Z0-9-]+$/.test(receiptNo) ? receiptNo : "";
  const box = "font-family: Inter, Arial, sans-serif; font-size: 7.5pt; color: #74786c;";
  // The app paints the page body; on paper only the receipt is printed.
  return <style>{`@media print { html, body { background: #fff !important; } } @page { size: letter; margin: 0.6in 0.65in 0.75in; @bottom-left { content: "Setti · Signed version receipt · No. ${number}"; ${box} } @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} } }`}</style>;
}

const cell = "border-b border-[var(--line)] px-2 py-2 align-top first:pl-0 last:pr-0";
const head = "whitespace-nowrap border-b border-[var(--ink)] px-2 py-1.5 text-left text-[9.5px] font-bold uppercase tracking-[0.1em] text-[var(--muted)] first:pl-0 last:pr-0";
const amount = "text-right tabular-nums whitespace-nowrap";
const row = "[break-inside:avoid]";

function Section({ number, title, aside, children }: { number: number; title: string; aside?: string; children: ReactNode }) {
  return <section className="grid gap-3">
    <div className="flex items-baseline gap-2.5 border-b border-[var(--ink)] pb-1.5 [break-after:avoid]">
      <span className="text-[11px] font-bold tabular-nums text-[var(--primary)]">{number}</span>
      <h2 className="text-[13px] font-bold uppercase tracking-[0.02em]">{title}</h2>
      {aside && <span className="ml-auto text-[11px] text-[var(--muted)]">{aside}</span>}
    </div>
    {children}
  </section>;
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-[11px] text-[var(--muted)]">{children}</span>;
}

function Table({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[600px] border-collapse text-[12px]">{children}</table></div>;
}

function itemDetail(item: ReceiptItem) {
  return `${item.vendor.replace(/\s*\((demo|simulated estimate)\)$/, "")} · ${item.sku}${item.quantity > 1 ? ` · ${item.quantity} ${item.unitLabel}` : ""}`;
}

function SealMark({ seal, id }: { seal: Seal; id: string }) {
  return <div role="img" aria-label={`Seal: ${seal.word.toLowerCase()}${seal.qualifier ? ` ${seal.qualifier.toLowerCase()}` : ""} on ${seal.date}; fingerprint ${seal.code}`}
    className={`h-[118px] w-[118px] shrink-0 ${seal.tone === "ok" ? "text-[#1e5638]" : "text-[var(--muted)]"}`}>
    <svg viewBox="0 0 128 128" aria-hidden="true" className="h-full w-full overflow-visible">
      <defs><path id={id} d="M 64,64 m -47,0 a 47,47 0 1,1 94,0 a 47,47 0 1,1 -94,0" /></defs>
      <circle cx="64" cy="64" r="61" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="64" cy="64" r="57.5" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <circle cx="64" cy="64" r="39" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <text fontSize="7" fontWeight="600" letterSpacing="0.8" fill="currentColor"><textPath href={`#${id}`} textLength="290" lengthAdjust="spacing">{seal.ring}</textPath></text>
      <text x="64" y={seal.qualifier ? 55 : 58} textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="1" fill="currentColor">{seal.word}</text>
      {seal.qualifier && <text x="64" y="63" textAnchor="middle" fontSize="5.6" fontWeight="600" letterSpacing="0.8" fill="currentColor">{seal.qualifier}</text>}
      <line x1="42" y1="66" x2="86" y2="66" stroke="currentColor" strokeWidth="0.6" />
      <text x="64" y="76" textAnchor="middle" fontSize="7.6" fontWeight="600" letterSpacing="0.6" fill="currentColor">{seal.date}</text>
      <text x="64" y="86" textAnchor="middle" fontFamily="ui-monospace, Consolas, monospace" fontSize="6.4" fill="currentColor">{seal.code}</text>
    </svg>
  </div>;
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="rounded border border-[var(--line)] bg-white px-2 py-0.5 text-[10.5px] hover:bg-[var(--canvas)] print:hidden"
    onClick={() => { void navigator.clipboard?.writeText(hash).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined); }}>
    {copied ? "Copied" : "Copy"}
  </button>;
}

function Fact({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return <div className="flex justify-between gap-3 border-b border-dotted border-[var(--line)] py-1.5 text-[12.5px]"><span className="text-[var(--muted)]">{label}</span><span className={`text-right tabular-nums ${strong ? "font-bold" : "font-medium"}`}>{value}</span></div>;
}

export function ReceiptDocument({ receipt, studioName = "" }: { receipt: VersionReceipt; studioName?: string }) {
  const demo = useDemoMode();
  const { project, version, agreement, totals, pending } = receipt;
  const seal = sealOf(receipt);
  const groups = paymentGroups(receipt);
  const certificate = certificateRows(receipt);
  const sample = receipt.signatures.every((signature) => signature.method === "sample");
  const lastSigned = receipt.signatures[receipt.signatures.length - 1];
  // What the version is, in fixed words: the AI draft's title is never shown.
  const changes = "changes" in version.document ? version.document.changes.length : null;
  const title = changes === null ? `${project.room}. First quote.` : `${project.room}. ${changes} ${changes === 1 ? "change" : "changes"} to version ${version.basedOn}.`;
  const actorName = (actor: string) => actor === "client" ? `${project.client} (client)` : actor === "designer" ? `${project.designer} (designer)` : actor;
  let section = 0;

  return <article className="grid gap-6 bg-white px-[clamp(20px,6vw,60px)] pb-10 pt-12 text-[13px] leading-relaxed shadow-[0_1px_2px_rgba(29,33,27,.1),0_10px_30px_rgba(29,33,27,.08)] [print-color-adjust:exact] print:p-0 print:shadow-none">
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b-2 border-[var(--ink)] pb-3.5">
      <div className="text-[22px] font-bold tracking-tight text-[var(--primary)]">Setti</div>
      <div className="grid gap-0.5 sm:text-right">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.16em]">Signed version receipt</span>
        <span className="font-mono text-[11.5px]">No. {receipt.receiptNo}</span>
        <span className="text-[11px] text-[var(--muted)]">Issued {ptDateTime(receipt.issuedAt)}</span>
      </div>
    </header>

    <div className="flex flex-wrap items-start justify-between gap-x-7 gap-y-4">
      <div className="min-w-0 flex-1 basis-80">
        <h1 className="text-[24px] font-semibold leading-tight tracking-tight [text-wrap:balance]">{project.name} · Quote version {version.number}</h1>
        <p className="mt-1.5 max-w-[60ch] text-[var(--muted)]">{title}</p>
        {version.replacedBy && <p className="mt-1.5 text-[12px] text-[var(--muted)]">Replaced by version {version.replacedBy}. Later steps on these items appear on that version&apos;s receipt.</p>}
      </div>
      <SealMark seal={seal} id={`seal-ring-${version.number}`} />
    </div>

    <dl className="grid border-y border-[var(--line)] sm:grid-cols-3">
      {[["Client", project.client, project.name], ["Designer", project.designer, studioName], ["Agreement", `${project.name} quote`, version.basedOn ? `Version ${version.number}, based on version ${version.basedOn}` : "Version 1"]].map(([label, value, note], index) =>
        <div key={label} className={`py-3 ${index ? "border-t border-[var(--line)] sm:border-l sm:border-t-0 sm:pl-3.5" : ""}`}>
          <dt className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</dt>
          <dd className="mt-1 font-semibold">{value}</dd>
          <dd className="text-[12px] text-[var(--muted)]">{note}</dd>
        </div>)}
    </dl>

    <div className="grid gap-x-7 sm:grid-cols-2">
      {version.sentAt && <Fact label="Sent" value={ptDateTime(version.sentAt)} />}
      {totals.previousCents !== null && <Fact label={`Previous total (V${version.basedOn})`} value={usd(totals.previousCents)} />}
      <Fact label={sample ? "Approved (sample)" : version.status === "changes_requested" ? "Sent back" : "Signed"} value={ptDateTime(lastSigned.at)} />
      <Fact label={version.number === 1 ? "Quote total" : `New total (V${version.number})`} value={usd(totals.totalCents)} strong />
      {agreement.kind === "opening" && <Fact label="Lines approved" value={`${agreement.lines.filter((line) => line.decision === "approved").length} of ${agreement.lines.length}`} />}
      {agreement.kind === "opening" && <Fact label="Approved total" value={usd(agreement.lines.filter((line) => line.decision === "approved").reduce((sum, line) => sum + line.totalCents, 0))} strong />}
      {totals.differenceCents !== null && <Fact label="Difference" value={signedUsd(totals.differenceCents)} strong />}
    </div>

    {agreement.kind === "change" ? <Section number={++section} title="Changes in this version" aside="USD">
      <Table>
        <thead><tr><th className={head}>#</th><th className={head}>Item</th><th className={`${head} text-right`}>Version {version.basedOn}</th><th className={`${head} text-right`}>Version {version.number}</th><th className={head}>Handling</th><th className={`${head} text-right`}>Change</th></tr></thead>
        <tbody>
          {agreement.changes.map((change, index) => {
            const retained = change.oldItem?.retainedCents ?? 0;
            const before = change.before?.totalCents ?? 0;
            const after = (change.after?.totalCents ?? 0) + retained;
            return <tr key={index} className={row}>
              <td className={`${cell} tabular-nums`}>{index + 1}</td>
              <td className={cell}>
                {change.before && change.after && change.action === "replace" ? <><span className="text-[var(--muted)] line-through decoration-[#b5b2a6]">{change.before.name}</span> → {change.after.name}</> : (change.after ?? change.before)?.name}
                <Sub>{change.after ? itemDetail(change.after) : change.before ? itemDetail(change.before) : ""}</Sub>
              </td>
              <td className={`${cell} ${amount}`}>{change.before ? usd(before) : "—"}</td>
              <td className={`${cell} ${amount}`}>{change.after || retained ? usd(after) : "—"}</td>
              <td className={cell}>{CHANGE_LABELS[change.action]}{change.oldItem && <Sub>{HANDLING_LABELS[change.oldItem.handling]} · {notRefundedText({ oldItemCostCents: retained, oldItemFees: change.oldItem.fees })}</Sub>}</td>
              <td className={`${cell} ${amount}`}>{signedUsd(after - before)}</td>
            </tr>;
          })}
          {agreement.unchanged.length > 0 && <tr className={row}>
            <td className={cell} />
            <td className={cell}>{agreement.unchanged.length === 1 ? agreement.unchanged[0].name : `${agreement.unchanged.length} other lines`}<Sub>{agreement.unchanged.length === 1 ? itemDetail(agreement.unchanged[0]) : agreement.unchanged.map((line) => line.name).join(", ")}</Sub></td>
            <td className={`${cell} ${amount}`}>{usd(agreement.unchanged.reduce((sum, line) => sum + line.totalCents, 0))}</td>
            <td className={`${cell} ${amount}`}>{usd(agreement.unchanged.reduce((sum, line) => sum + line.totalCents, 0))}</td>
            <td className={cell}>Unchanged</td>
            <td className={`${cell} ${amount}`}>{usd(0)}</td>
          </tr>}
          <tr className={`${row} font-bold`}>
            <td className="border-b-2 border-t border-[var(--ink)] py-2" /><td className="border-b-2 border-t border-[var(--ink)] px-2 py-2">Total</td>
            <td className={`border-b-2 border-t border-[var(--ink)] px-2 py-2 ${amount}`}>{usd(totals.previousCents ?? 0)}</td>
            <td className={`border-b-2 border-t border-[var(--ink)] px-2 py-2 ${amount}`}>{usd(totals.totalCents)}</td>
            <td className="border-b-2 border-t border-[var(--ink)] px-2 py-2" />
            <td className={`border-b-2 border-t border-[var(--ink)] py-2 pl-2 ${amount}`}>{signedUsd(totals.differenceCents ?? 0)}</td>
          </tr>
        </tbody>
      </Table>
    </Section> : <Section number={++section} title="Lines and decisions" aside="USD">
      <Table>
        <thead><tr><th className={head}>#</th><th className={head}>Item</th><th className={`${head} text-right`}>Amount</th><th className={head}>Decision</th><th className={head}>Signed in</th></tr></thead>
        <tbody>
          {agreement.lines.map((line, index) => {
            const signing = receipt.signatures.findIndex((signature) => signature.signingId && signature.signingId === line.signingId);
            return <tr key={line.itemId} className={row}>
              <td className={`${cell} tabular-nums`}>{index + 1}</td>
              <td className={cell}>{line.name}<Sub>{itemDetail(line)}</Sub></td>
              <td className={`${cell} ${amount}`}>{usd(line.totalCents)}</td>
              <td className={cell}>{DECISION_LABELS[line.decision]}{line.note && <Sub>Reason: {line.note}</Sub>}</td>
              <td className={cell}>{sample ? "Sample approval" : signing >= 0 ? `Signing ${signing + 1}` : "—"}</td>
            </tr>;
          })}
          <tr className={`${row} font-bold`}>
            <td className="border-b-2 border-t border-[var(--ink)] py-2" /><td className="border-b-2 border-t border-[var(--ink)] px-2 py-2">Total</td>
            <td className={`border-b-2 border-t border-[var(--ink)] px-2 py-2 ${amount}`}>{usd(totals.totalCents)}</td>
            <td className="border-b-2 border-t border-[var(--ink)] px-2 py-2" colSpan={2}>{agreement.lines.filter((line) => line.decision === "approved").length} of {agreement.lines.length} approved</td>
          </tr>
        </tbody>
      </Table>
    </Section>}

    {agreement.kind === "change" && <Section number={++section} title="Basis for the change"
      aside={agreement.source.kind === "vendor" ? `Source: supplier notice${agreement.source.vendor ? ` · ${agreement.source.vendor}` : ""}` : agreement.source.kind ? "Source: client conversation" : undefined}>
      {agreement.source.kind === "vendor" && agreement.source.notice && <p className="border-l-2 border-[var(--line)] pl-3.5 text-[12.5px]">{agreement.source.notice}</p>}
      {agreement.source.messages.map((message) => <blockquote key={message.id} className="m-0 grid gap-1 border-l-2 border-[var(--line)] pl-3.5 [break-inside:avoid]">
        <span className="text-[11px] text-[var(--muted)]">{actorName(message.actor)} · project chat · {ptDateTime(message.createdAt)}</span>
        <p className="whitespace-pre-wrap text-[12.5px]">“{message.text}”</p>
      </blockquote>)}
      {!agreement.source.messages.length && !agreement.source.notice && <p className="text-[12px] text-[var(--muted)]">This version was frozen before Setti kept its source messages.</p>}
      {agreement.terms && <div className="grid gap-1"><span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Terms {project.client} {version.status === "changes_requested" ? "reviewed" : "confirmed"}</span><p className="whitespace-pre-wrap text-[12.5px] text-[#4a4f45]">{agreement.terms}</p></div>}
    </Section>}

    <Section number={++section} title="Payment record" aside={pending ? "As reported by PayPal at issue" : undefined}>
      {groups.length || pending?.actions.length ? <Table>
        <thead><tr><th className={head}>Date</th><th className={head}>Item</th><th className={head}>Action</th><th className={`${head} text-right`}>Amount</th><th className={head}>PayPal reference</th><th className={head}>Confirmed by PayPal</th></tr></thead>
        <tbody>
          {groups.map((group) => [
            <tr key={group.title} className={row}><td colSpan={6} className="bg-[#faf9f6] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#4a4f45]">{group.title}</td></tr>,
            ...group.rows.map((step, index) => <tr key={`${group.title}-${index}`} className={row}>
              <td className={`${cell} whitespace-nowrap tabular-nums`}>{ptDay(step.at)}</td>
              <td className={cell}>{step.item}</td>
              <td className={cell}>{ACTION_LABELS[step.action]}</td>
              <td className={`${cell} ${amount}`}>{usd(step.amountCents)}</td>
              <td className={`${cell} break-all font-mono text-[11px]`}>{paypalReference(step)}</td>
              <td className={`${cell} whitespace-nowrap tabular-nums`}>{step.confirmed ? `${ptDay(step.confirmed.at)} · ${VIA_LABELS[step.confirmed.via]}` : "Not yet"}</td>
            </tr>),
          ])}
          {pending && pending.actions.length > 0 && [
            <tr key="pending" className={row}><td colSpan={6} className="bg-[#faf9f6] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#4a4f45]">Pending at issue</td></tr>,
            ...pendingRows(pending).map((action, index) => <tr key={`pending-${index}`} className={`${row} italic text-[#8a5a00]`}>
              <td className={cell}>—</td><td className={cell}>{action.label}{action.items && <Sub>{action.items}</Sub>}</td><td className={cell}>{PENDING_LABELS[action.kind]}</td>
              <td className={`${cell} ${amount}`}>{usd(action.amountCents)}</td><td className={cell}>{TIMING_LABELS[action.timing]}</td><td className={cell}>—</td>
            </tr>),
          ]}
        </tbody>
      </Table> : <p className="text-[12px] text-[var(--muted)]">No PayPal step has been taken for this version&apos;s items{pending ? " yet" : ""}.</p>}
      {pending && <div className="flex flex-wrap border border-[var(--line)]">
        {([["On hold", pending.position.heldCents], ["Charged", pending.position.capturedCents], ["Refunded", pending.position.refundedCents]] as const).map(([label, cents], index) =>
          <div key={label} className={`min-w-[120px] flex-1 px-3.5 py-2 text-right ${index ? "border-l border-[var(--line)]" : ""}`}>
            <div className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
            <div className="mt-0.5 text-[14px] font-bold tabular-nums">{usd(cents)}</div>
          </div>)}
      </div>}
      {pending && pending.blockers.length > 0 && <p className="text-[11.5px] text-[#8a5a00]">Some steps could not be worked out when this receipt was issued: {pending.blockers.join(" ")}</p>}
      {groups.some((group) => group.title.startsWith("Brought forward")) && <p className="text-[11px] text-[var(--muted)]">Steps brought forward were taken under an earlier version on the same items; they also appear on that version&apos;s receipt.</p>}
    </Section>

    <Section number={++section} title="Signature certificate">
      <Table>
        <thead><tr><th className={head}>Event</th><th className={head}>By</th><th className={head}>Date and time</th><th className={head}>Fingerprint at event</th></tr></thead>
        <tbody>
          {certificate.map((entry, index) => <tr key={index} className={row}>
            <td className={cell}>{entry.event}</td>
            <td className={cell}>{entry.by}<Sub>{entry.role}</Sub></td>
            <td className={`${cell} tabular-nums`}>{entry.at ? <>{ptDateTime(entry.at, true)}<Sub>{utcTime(entry.at)}</Sub></> : "—"}</td>
            <td className={cell}>{entry.fingerprint ? <span className="font-mono text-[11px]">{shortHash(entry.fingerprint)}</span> : "—"}{entry.matches !== null && <span className={`ml-1 font-semibold ${entry.matches ? "text-[#1f6b45]" : "text-red-700"}`}>· {entry.matches ? "matches" : "does not match"}</span>}</td>
          </tr>)}
        </tbody>
      </Table>
      <div className="grid items-end gap-x-7 gap-y-4 sm:grid-cols-[minmax(0,1fr)_240px]">
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">{sample
          ? `This version came with the demo already approved. The approval is a sample; ${project.client} did not sign it in Setti.`
          : version.number === 1
            ? `${project.client} decided each line and signed by typing their name in Setti. Each signing is recorded with the fingerprint of the agreed lines it covers.`
            : `${project.client} ${version.status === "changes_requested" ? "sent version " + version.number + " back" : "confirmed version " + version.number} by typing their name in Setti. Setti checked that it carries the same fingerprint as the version ${version.sentBy ?? project.designer} sent.`}</p>
        <div className="grid gap-1">
          <span className="px-1 font-signature text-[32px] leading-none text-[#23305e]">{lastSigned.signature.replace(/\s*\(demo signature\)$/, "")}</span>
          <span className="border-t border-[var(--ink)] pt-1 text-[11px] text-[var(--muted)]">{sample ? "Sample signature · included with the demo" : `Typed signature · ${lastSigned.name}, client`}</span>
        </div>
      </div>
    </Section>

    <Section number={++section} title="Verification">
      <div className="grid">
        {version.contentHash && <HashRow label={`Version ${version.number} · SHA-256`} hash={version.contentHash} />}
        {version.revision && <HashRow label="Agreed lines · SHA-256" hash={version.revision.contentHash} />}
      </div>
      {version.contentHash ? <>
        <ol className="m-0 grid list-decimal gap-0.5 pl-5 text-[12px] text-[#4a4f45]">
          <li>Download the record (JSON) from this receipt in Setti.</li>
          <li>Hash <span className="font-mono text-[11px]">version.document</span> as JSON with its keys sorted and no spaces.</li>
          <li>Compare the result with the version {version.number} fingerprint above.</li>
        </ol>
        <pre className="m-0 overflow-x-auto whitespace-pre rounded border border-[var(--line)] bg-[#f4f3ef] px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-[#2c3129] print:whitespace-pre-wrap print:break-all">{verifyCommand(receipt.receiptNo)}</pre>
      </> : <p className="text-[12px] text-[var(--muted)]">This version came with the demo, so it has no sent-document fingerprint. Setti recorded the fingerprint of its agreed lines when the project was set up.</p>}
    </Section>

    <div className="grid gap-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
      <p>This receipt records the agreement as signed and the PayPal activity reported when it was issued. Money that moves later appears on a newer receipt. It is not a tax invoice.</p>
      <p>Not included: {receipt.notIncluded.join(", ")}. {demo ? "Demo project on PayPal Sandbox" : "PayPal Sandbox"}; no real money moved.</p>
    </div>

    <footer className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-[var(--line)] pt-2.5 text-[10px] text-[var(--muted)] print:hidden">
      <span>Setti · Signed version receipt · No. {receipt.receiptNo}</span>
      <span>{demo ? "Demo project · PayPal Sandbox" : "PayPal Sandbox"}</span>
    </footer>
  </article>;
}

function HashRow({ label, hash }: { label: string; hash: string }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--line)] py-1.5 text-[12px] [break-inside:avoid]">
    <span className="w-full text-[var(--muted)] sm:w-[170px] sm:shrink-0">{label}</span>
    <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{hash}</span>
    <CopyHash hash={hash} />
  </div>;
}
