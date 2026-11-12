"use client";

import { Check, LoaderCircle, X } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { notRefundedText } from "@/pricing/fees";
import { BrandMark } from "../BrandMark";
import type { ReceiptItem, VersionReceipt } from "@/receipts/types";
import { useDemoMode } from "../demo-mode";
import { units } from "../pricing/units";
import { A4Sheets, type SheetBlock, type SheetTable } from "./A4Sheets";
import {
  ACTION_LABELS, CHANGE_LABELS, DECISION_LABELS, HANDLING_LABELS, PENDING_LABELS, TIMING_LABELS, VIA_LABELS,
  certificateRows, changeRows, documentName, isSigned, paymentGroups, paypalReference, pendingRows, ptDateTime, ptDay, sealOf, shortHash, signedUsd, usd, utcTime, verifyCommand, type Seal,
} from "./receipt-view";

const cell = "border-b border-[var(--line)] px-2 py-2 align-top first:pl-0 last:pr-0";
const head = "border-b border-[var(--ink)] px-2 py-1.5 text-left align-bottom text-[9.5px] font-bold uppercase tracking-[0.1em] text-[var(--muted)] first:pl-0 last:pr-0";
const total = "border-b-2 border-t border-[var(--ink)] px-2 py-2 first:pl-0 last:pr-0";
const amount = "text-right tabular-nums whitespace-nowrap";
const groupTitle = "bg-[#faf9f6] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#4a4f45]";

function SectionHead({ number, title, aside, level: Heading }: { number: number; title: string; aside?: string; level: "h2" | "h3" }) {
  return <div className="flex items-baseline gap-2.5 border-b border-[var(--ink)] pb-1.5">
    <span className="text-[11px] font-bold tabular-nums text-[var(--primary)]">{number}</span>
    <Heading className="text-[13px] font-bold uppercase tracking-[0.02em]">{title}</Heading>
    {aside && <span className="ml-auto text-right text-[11px] text-[var(--muted)]">{aside}</span>}
  </div>;
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-[11px] text-[var(--muted)]">{children}</span>;
}

/** What the client reads under an item: its quantity. The supplier and its reference stay with the studio. */
function itemDetail(item: ReceiptItem) {
  return item.quantity > 1 ? `${units(item.quantity, item.unitLabel)}${item.unitLabel === "each" ? " each" : ""}` : "";
}

/** The seal on a signed version; a dashed stamp on one the client has not signed. */
function SealMark({ seal }: { seal: Seal }) {
  const ring = `seal-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const dashed = seal.tone === "awaiting" || seal.tone === "unsigned";
  const dash = dashed ? { strokeDasharray: "5 3.5" } : {};
  const said = `${seal.word}${seal.qualifier ? ` ${seal.qualifier}` : ""}`.toLowerCase();
  return <div role="img" aria-label={dashed ? `Stamp: ${said}, ${seal.date.toLowerCase()}; fingerprint ${seal.code}` : `Seal: ${said} on ${seal.date}; fingerprint ${seal.code}`}
    className={`h-[118px] w-[118px] shrink-0 ${seal.tone === "ok" ? "text-[#1e5638]" : seal.tone === "awaiting" ? "text-amber-800" : "text-[var(--muted)]"}`}>
    <svg viewBox="0 0 128 128" aria-hidden="true" className="h-full w-full overflow-visible">
      <defs><path id={ring} d="M 64,64 m -47,0 a 47,47 0 1,1 94,0 a 47,47 0 1,1 -94,0" /></defs>
      {seal.tone === "awaiting" && <circle cx="64" cy="64" r="61" className="fill-amber-50" />}
      <circle cx="64" cy="64" r="61" fill="none" stroke="currentColor" strokeWidth={dashed ? 2 : 1.6} {...dash} />
      <circle cx="64" cy="64" r="57.5" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <circle cx="64" cy="64" r="39" fill="none" stroke="currentColor" strokeWidth="0.6" {...dash} />
      <text fontSize="7" fontWeight="600" letterSpacing="0.8" fill="currentColor"><textPath href={`#${ring}`} textLength="290" lengthAdjust="spacing">{seal.ring}</textPath></text>
      {dashed ? <>
        <text x="64" y="53" textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="1" fill="currentColor">{seal.word}</text>
        <text x="64" y="63" textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="1" fill="currentColor">{seal.qualifier}</text>
      </> : <>
        <text x="64" y={seal.qualifier ? 55 : 58} textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="1" fill="currentColor">{seal.word}</text>
        {seal.qualifier && <text x="64" y="63" textAnchor="middle" fontSize="5.6" fontWeight="600" letterSpacing="0.8" fill="currentColor">{seal.qualifier}</text>}
      </>}
      <line x1="42" y1="66" x2="86" y2="66" stroke="currentColor" strokeWidth="0.6" />
      <text x="64" y="76" textAnchor="middle" fontSize={dashed ? 6.2 : 7.6} fontWeight="600" letterSpacing="0.6" fill="currentColor">{seal.date}</text>
      <text x="64" y="86" textAnchor="middle" fontFamily="ui-monospace, Consolas, monospace" fontSize="6.4" fill="currentColor">{seal.code}</text>
    </svg>
  </div>;
}

/** Approve or decline one line, on the document. Choosing the same again clears it. */
function DecideButtons({ name, choice, onChoose }: { name: string; choice: "approved" | "declined" | undefined; onChoose: (decision: "approved" | "declined" | null) => void }) {
  const base = "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold";
  return <span className="inline-flex gap-1" role="group" aria-label={`Your decision on ${name}`}>
    <button type="button" aria-pressed={choice === "approved"} onClick={() => onChoose(choice === "approved" ? null : "approved")} className={`${base} ${choice === "approved" ? "border-emerald-700 bg-emerald-700 text-white" : "border-[var(--line)] bg-white text-slate-600 hover:border-emerald-700"}`}><Check className="h-3 w-3" strokeWidth={3} />Approve</button>
    <button type="button" aria-pressed={choice === "declined"} onClick={() => onChoose(choice === "declined" ? null : "declined")} className={`${base} ${choice === "declined" ? "border-[#9c3d34] bg-[#9c3d34] text-white" : "border-[var(--line)] bg-white text-slate-600 hover:border-[#9c3d34]"}`}><X className="h-3 w-3" strokeWidth={3} />Decline</button>
  </span>;
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="rounded border border-[var(--line)] bg-white px-2 py-0.5 text-[10.5px] hover:bg-[var(--canvas)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--primary-fill)] print:hidden"
    onClick={() => { void navigator.clipboard?.writeText(hash).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined); }}>
    {copied ? "Copied" : "Copy"}
  </button>;
}

function Fact({ label, value, strong, waiting }: { label: string; value: ReactNode; strong?: boolean; waiting?: boolean }) {
  return <div className="flex justify-between gap-3 border-b border-dotted border-[var(--line)] py-1.5 text-[12.5px]"><span className="text-[var(--muted)]">{label}</span><span className={`text-right tabular-nums ${strong ? "font-bold" : "font-medium"} ${waiting ? "text-amber-800" : ""}`}>{value}</span></div>;
}

function HashRow({ label, hash }: { label: string; hash: string }) {
  return <div className="flex items-baseline gap-x-3 border-b border-[var(--line)] py-1.5 text-[12px]">
    <span className="w-[170px] shrink-0 text-[var(--muted)]">{label}</span>
    <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{hash}</span>
    <CopyHash hash={hash} />
  </div>;
}

const TABLES: Record<string, SheetTable> = {
  changes: { columns: ["28px", "auto", "84px", "84px", "146px", "84px"], head: null },
  lines: { columns: ["28px", "auto", "88px", "148px", "84px"], head: null },
  payments: { columns: ["56px", "auto", "84px", "88px", "158px", "116px"], head: null },
  certificate: { columns: ["150px", "142px", "172px", "auto"], head: null },
};

/**
 * The version receipt as unbreakable blocks, in reading order: letterhead,
 * title, parties, facts, each table row, each quoted message, the terms, the
 * signature and the notes. Before the client signs it reads as the formal
 * quote of the version as sent; after, it is the signed version receipt.
 */
/** The client deciding an open V1 on the document itself: a choice per undecided line, and a reason for each decline. */
export interface OpeningDecide {
  choices: Readonly<Record<string, { decision: "approved" | "declined"; note: string }>>;
  onChoose: (itemId: string, decision: "approved" | "declined" | null) => void;
  onReason: (itemId: string, note: string) => void;
}

function receiptBlocks(receipt: VersionReceipt, studioName: string, demo: boolean, embedded: boolean, decide?: OpeningDecide) {
  const { project, version, agreement, totals, pending } = receipt;
  const signed = isSigned(receipt);
  const draft = version.status === "draft";
  // A draft reads as the quote the client will receive once it is sent.
  const awaiting = version.status === "awaiting_signature" || draft;
  const sample = signed && receipt.signatures.every((signature) => signature.method === "sample");
  const lastSigned = receipt.signatures.at(-1) ?? null;
  const groups = paymentGroups(receipt);
  const certificate = certificateRows(receipt);
  // What the version is, in fixed words: the AI draft's title is never shown.
  const changeCount = "changes" in version.document ? version.document.changes.length : null;
  // A project without a scope yet starts the line with what the version is.
  const place = project.room.trim() ? `${project.room.trim()}. ` : "";
  const title = changeCount === null ? `${place}First quote.` : `${place}${changeCount} ${changeCount === 1 ? "change" : "changes"} to version ${version.basedOn}.`;
  const designer = version.sentBy ?? project.designer;
  // Inside another page the document's title is not the page's.
  const Title = embedded ? "h2" : "h1";
  const level = embedded ? "h3" : "h2";

  const blocks: SheetBlock[] = [];
  const tables: Record<string, SheetTable> = {};
  const add = (key: string, node: ReactNode, gap = 24, keepWithNext = false) => { blocks.push({ key, node, gap, keepWithNext }); };
  /** A table row; the first of its table sits a little below the heading. */
  const row = (table: string, key: string, cells: ReactNode, options: { className?: string; keepWithNext?: boolean } = {}) => {
    blocks.push({ key: `${table}-${key}`, table, cells, gap: blocks.at(-1)?.table === table ? 0 : 12, ...options });
  };
  const table = (id: keyof typeof TABLES, cells: ReactNode) => { tables[id] = { ...TABLES[id], head: cells }; };
  let section = 0;
  const heading = (name: string, aside?: string) => { section++; add(`section-${section}`, <SectionHead number={section} title={name} aside={aside} level={level} />, 24, true); };

  add("letterhead", <header className="flex items-start justify-between gap-x-6 border-b-2 border-[var(--ink)] pb-3.5">
    <div className="flex items-center gap-2.5 text-[22px] font-bold tracking-tight text-[var(--ink)]"><BrandMark className="h-8 w-8" />Setti</div>
    <div className="grid gap-0.5 text-right">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.16em]">{signed ? "Signed version receipt" : `Quote · version ${version.number}`}</span>
      <span className="font-mono text-[11.5px]">No. {receipt.receiptNo}</span>
      <span className="text-[11px] text-[var(--muted)]">{draft ? `Preview ${ptDateTime(receipt.issuedAt)} · not sent` : signed || !version.sentAt ? `Issued ${ptDateTime(receipt.issuedAt)}` : `Sent ${ptDateTime(version.sentAt)}`}</span>
    </div>
  </header>, 0);

  add("title", <div className="flex items-start justify-between gap-x-7">
    <div className="min-w-0 flex-1">
      <Title className="text-[24px] font-semibold leading-tight tracking-tight [text-wrap:balance]">{project.name} · Quote version {version.number}</Title>
      <p className="mt-1.5 max-w-[60ch] text-[var(--muted)]">{title}</p>
      {signed && version.replacedBy && <p className="mt-1.5 text-[12px] text-[var(--muted)]">Replaced by version {version.replacedBy}. Later steps on these items appear on that version&apos;s receipt.</p>}
      {version.status === "superseded" && <p className="mt-1.5 text-[12px] text-[var(--muted)]">A newer version replaced this one before {project.client} signed it.</p>}
    </div>
    <SealMark seal={sealOf(receipt)} />
  </div>);

  add("parties", <dl className="grid grid-cols-3 border-y border-[var(--line)]">
    {[["Client", project.client, project.name], ["Designer", project.designer, studioName], ["Agreement", `${project.name} quote`, version.basedOn ? `Version ${version.number}, based on version ${version.basedOn}` : "Version 1"]].map(([label, value, note], index) =>
      <div key={label} className={`py-3 ${index ? "border-l border-[var(--line)] pl-3.5" : ""}`}>
        <dt className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</dt>
        <dd className="mt-1 font-semibold">{value}</dd>
        <dd className="text-[12px] text-[var(--muted)]">{note}</dd>
      </div>)}
  </dl>);

  add("facts", <div className="grid grid-cols-2 gap-x-7">
    {version.sentAt && <Fact label="Sent" value={ptDateTime(version.sentAt)} />}
    {totals.previousCents !== null && <Fact label={`Previous total (V${version.basedOn})`} value={usd(totals.previousCents)} />}
    {lastSigned ? <Fact label={sample ? "Approved (sample)" : version.status === "changes_requested" ? "Sent back" : "Signed"} value={ptDateTime(lastSigned.at)} />
      : <Fact label="Signed" value={awaiting ? "Not yet" : "Not signed"} waiting={awaiting} />}
    <Fact label={version.number === 1 ? "Quote total" : `New total (V${version.number})`} value={usd(totals.totalCents)} strong />
    {agreement.kind === "opening" && signed && <Fact label="Lines approved" value={`${agreement.lines.filter((line) => line.decision === "approved").length} of ${agreement.lines.length}`} />}
    {agreement.kind === "opening" && signed && <Fact label="Approved total" value={usd(agreement.lines.filter((line) => line.decision === "approved").reduce((sum, line) => sum + line.totalCents, 0))} strong />}
    {totals.differenceCents !== null && <Fact label="Difference" value={signedUsd(totals.differenceCents)} strong />}
  </div>);

  if (agreement.kind === "change") {
    // The whole quote, every line: the changes first, then each line this version leaves as it was.
    heading(`Quote version ${version.number}`, `USD · ${agreement.changes.length} changed${agreement.unchanged.length ? `, ${agreement.unchanged.length} unchanged` : ""}`);
    table("changes", <><th className={head}>#</th><th className={head}>Item</th><th className={`${head} text-right`}>Version {version.basedOn}</th><th className={`${head} text-right`}>Version {version.number}</th><th className={head}>Handling</th><th className={`${head} text-right`}>Change</th></>);
    const rows = changeRows(agreement.changes);
    rows.forEach(({ change, beforeCents, afterCents, changeCents }, index) => row("changes", String(index), <>
      <td className={`${cell} tabular-nums`}>{index + 1}</td>
      <td className={cell}>
        {change.before && change.after && change.action === "replace" ? <><span className="text-[var(--muted)] line-through decoration-[#b5b2a6]">{change.before.name}</span> → {change.after.name}</> : (change.after ?? change.before)?.name}
        <Sub>{change.after ? itemDetail(change.after) : change.before ? itemDetail(change.before) : ""}</Sub>
      </td>
      <td className={`${cell} ${amount}`}>{beforeCents === null ? "—" : usd(beforeCents)}</td>
      <td className={`${cell} ${amount}`}>{afterCents === null ? "—" : usd(afterCents)}</td>
      <td className={cell}>{CHANGE_LABELS[change.action]}{change.oldItem && <Sub>{HANDLING_LABELS[change.oldItem.handling]} · {notRefundedText({ oldItemCostCents: change.oldItem.retainedCents, oldItemFees: change.oldItem.fees })}</Sub>}</td>
      <td className={`${cell} ${amount}`}>{signedUsd(changeCents)}</td>
    </>, { keepWithNext: index === rows.length - 1 && !agreement.unchanged.length }));
    agreement.unchanged.forEach((line, index) => row("changes", `unchanged-${index}`, <>
      <td className={cell} />
      <td className={`${cell} text-[var(--muted)]`}>{line.name}<Sub>{itemDetail(line)}</Sub></td>
      <td className={`${cell} ${amount} text-[var(--muted)]`}>{usd(line.totalCents)}</td>
      <td className={`${cell} ${amount} text-[var(--muted)]`}>{usd(line.totalCents)}</td>
      <td className={`${cell} text-[var(--muted)]`}>Unchanged</td>
      <td className={`${cell} ${amount} text-[var(--muted)]`}>{usd(0)}</td>
    </>, { keepWithNext: index === agreement.unchanged.length - 1 }));
    row("changes", "total", <>
      <td className={total} /><td className={total}>Total</td>
      <td className={`${total} ${amount}`}>{usd(totals.previousCents ?? 0)}</td>
      <td className={`${total} ${amount}`}>{usd(totals.totalCents)}</td>
      <td className={total} />
      <td className={`${total} ${amount}`}>{signedUsd(totals.differenceCents ?? 0)}</td>
    </>, { className: "font-bold" });

    // The terms are part of what the client signs; where the change came from stays in the project chat.
    if (agreement.terms) {
      heading("Terms", !signed ? `Sent to ${project.client}` : `${project.client} ${version.status === "changes_requested" ? "reviewed" : "confirmed"} them`);
      add("terms", <p className="whitespace-pre-wrap text-[12.5px] text-[#4a4f45]">{agreement.terms}</p>, 12);
    }
  } else {
    heading("Lines and decisions", "USD");
    table("lines", <><th className={head}>#</th><th className={head}>Item</th><th className={`${head} text-right`}>Amount</th><th className={head}>Decision</th><th className={head}>Signed in</th></>);
    agreement.lines.forEach((line, index) => {
      const signing = receipt.signatures.findIndex((signature) => signature.signingId && signature.signingId === line.signingId);
      row("lines", line.itemId, <>
        <td className={`${cell} tabular-nums`}>{index + 1}</td>
        <td className={cell}>{line.name}<Sub>{itemDetail(line)}</Sub></td>
        <td className={`${cell} ${amount}`}>{usd(line.totalCents)}</td>
        <td className={cell}>{decide && line.decision === "pending" ? <DecideButtons name={line.name} choice={decide.choices[line.itemId]?.decision} onChoose={(decision) => decide.onChoose(line.itemId, decision)} /> : <>{DECISION_LABELS[line.decision]}{line.note && <Sub>Reason: {line.note}</Sub>}</>}</td>
        <td className={cell}>{sample ? "Sample approval" : signing >= 0 ? `Signing ${signing + 1}` : "—"}</td>
      </>, { keepWithNext: index === agreement.lines.length - 1 && decide?.choices[line.itemId]?.decision !== "declined" });
      // A decline carries the client's reason, written on the line it is about.
      const declined = decide && line.decision === "pending" && decide.choices[line.itemId]?.decision === "declined" ? decide.choices[line.itemId] : null;
      if (declined) row("lines", `${line.itemId}-reason`, <td colSpan={5} className={`${cell} bg-[#fdf6f5]`}>
        <label className="flex items-center gap-2 text-[11px] text-[#9c3d34]"><span className="shrink-0 font-semibold">Reason</span>
          <input value={declined.note} onChange={(event) => decide!.onReason(line.itemId, event.target.value)} maxLength={1000} placeholder="Why are you declining this line? Your designer reads it." aria-label={`Reason for declining ${line.name}`}
            className="min-w-0 flex-1 rounded-md border border-[#f3c7c3] bg-white px-2 py-1 text-[12px] text-[var(--ink)] outline-none focus:border-[#9c3d34]" />
          {!declined.note.trim() && <span className="shrink-0">Needed</span>}</label>
      </td>);
    });
    row("lines", "total", <>
      <td className={total} /><td className={total}>Total</td>
      <td className={`${total} ${amount}`}>{usd(totals.totalCents)}</td>
      <td className={total} colSpan={2}>{agreement.lines.filter((line) => line.decision === "approved").length} of {agreement.lines.length} approved</td>
    </>, { className: "font-bold" });
  }

  heading("Payment record", pending ? "As reported by PayPal at issue" : undefined);
  if (groups.length || pending?.actions.length) {
    table("payments", <><th className={head}>Date</th><th className={head}>Item</th><th className={head}>Action</th><th className={`${head} text-right`}>Amount</th><th className={head}>PayPal reference</th><th className={head}>Confirmed by PayPal</th></>);
    for (const group of groups) {
      row("payments", group.title, <td colSpan={6} className={groupTitle}>{group.title}</td>, { keepWithNext: true });
      group.rows.forEach((step, index) => row("payments", `${group.title}-${index}`, <>
        <td className={`${cell} whitespace-nowrap tabular-nums`}>{ptDay(step.at)}</td>
        <td className={cell}>{step.item}</td>
        <td className={cell}>{ACTION_LABELS[step.action]}</td>
        <td className={`${cell} ${amount}`}>{usd(step.amountCents)}</td>
        <td className={`${cell} break-all font-mono text-[11px]`}>{paypalReference(step)}</td>
        <td className={`${cell} tabular-nums`}>{step.confirmed ? `${ptDay(step.confirmed.at)} · ${VIA_LABELS[step.confirmed.via]}` : "Not yet"}</td>
      </>));
    }
    if (pending && pending.actions.length > 0) {
      row("payments", "pending", <td colSpan={6} className={groupTitle}>Pending at issue</td>, { keepWithNext: true });
      pendingRows(pending).forEach((action, index) => row("payments", `pending-${index}`, <>
        <td className={cell}>—</td><td className={cell}>{action.label}{action.items && <Sub>{action.items}</Sub>}</td><td className={cell}>{PENDING_LABELS[action.kind]}</td>
        <td className={`${cell} ${amount}`}>{usd(action.amountCents)}</td><td className={cell}>{TIMING_LABELS[action.timing]}</td><td className={cell}>—</td>
      </>, { className: "italic text-[#8a5a00]" }));
    }
  } else add("no-payments", <p className="text-[12px] text-[var(--muted)]">No PayPal step has been taken for this version&apos;s items{pending || !signed ? " yet" : ""}.</p>, 12);
  if (pending) add("position", <div className="flex border border-[var(--line)]">
    {([["On hold", pending.position.heldCents], ["Charged", pending.position.capturedCents], ["Refunded", pending.position.refundedCents]] as const).map(([label, cents], index) =>
      <div key={label} className={`min-w-[120px] flex-1 px-3.5 py-2 text-right ${index ? "border-l border-[var(--line)]" : ""}`}>
        <div className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
        <div className="mt-0.5 text-[14px] font-bold tabular-nums">{usd(cents)}</div>
      </div>)}
  </div>, 12);
  if (pending && pending.blockers.length > 0) add("blockers", <p className="text-[11.5px] text-[#8a5a00]">Some steps could not be worked out when this receipt was issued: {pending.blockers.join(" ")}</p>, 12);
  if (groups.some((group) => group.title.startsWith("Brought forward"))) add("brought-forward", <p className="text-[11px] text-[var(--muted)]">Steps brought forward were taken under an earlier version on the same items; they also appear on that version&apos;s receipt.</p>, 12);

  heading("Signature certificate");
  table("certificate", <><th className={head}>Event</th><th className={head}>By</th><th className={head}>Date and time</th><th className={head}>Fingerprint at event</th></>);
  certificate.forEach((entry, index) => row("certificate", String(index), <>
    <td className={cell}>{entry.event}</td>
    <td className={cell}>{entry.by}<Sub>{entry.role}</Sub></td>
    <td className={`${cell} tabular-nums`}>{entry.at ? <>{ptDateTime(entry.at, true)}<Sub>{utcTime(entry.at)}</Sub></> : "—"}</td>
    <td className={cell}>{entry.fingerprint ? <span className="font-mono text-[11px]">{shortHash(entry.fingerprint)}</span> : "—"}{entry.matches !== null && <span className={`ml-1 font-semibold ${entry.matches ? "text-[#1f6b45]" : "text-red-700"}`}>· {entry.matches ? "matches" : "does not match"}</span>}</td>
  </>, { className: !entry.at ? "text-[var(--muted)]" : undefined }));
  const said = sample
    ? `This version came with the demo already approved. The approval is a sample; ${project.client} did not sign it in Setti.`
    : !signed ? version.status === "superseded" ? `${project.client} did not sign version ${version.number}; a newer version replaced it.`
      : version.number === 1 ? `${project.client} has not signed quote version 1 yet. They decide each line and sign by typing their name in Setti; each signing is recorded with the fingerprint of the agreed lines it covers.`
        : `${project.client} has not signed version ${version.number} yet. They confirm it by typing their name in Setti, which checks that it carries the same fingerprint as the version ${designer} sent.`
      : version.number === 1
        ? `${project.client} decided each line and signed by typing their name in Setti. Each signing is recorded with the fingerprint of the agreed lines it covers.`
        : `${project.client} ${version.status === "changes_requested" ? "sent version " + version.number + " back" : "confirmed version " + version.number} by typing their name in Setti. Setti checked that it carries the same fingerprint as the version ${designer} sent.`;
  add("signature", <div className="grid grid-cols-[minmax(0,1fr)_240px] items-end gap-x-7">
    <p className="text-[11px] leading-relaxed text-[var(--muted)]">{said}</p>
    <div className="grid gap-1">
      <span className="min-h-[32px] px-1 font-signature text-[32px] leading-none text-[#23305e]">{lastSigned?.signature.replace(/\s*\(demo signature\)$/, "")}</span>
      <span className={`border-t border-[var(--ink)] pt-1 text-[11px] ${awaiting ? "text-amber-800" : "text-[var(--muted)]"}`}>{sample ? "Sample signature · included with the demo"
        : lastSigned ? `Typed signature · ${lastSigned.name}, client` : `${project.client}, client · ${awaiting ? "awaiting signature" : "not signed"}`}</span>
    </div>
  </div>, 12);

  heading("Verification");
  if (version.contentHash) add("hash-version", <HashRow label={`Version ${version.number} · SHA-256`} hash={version.contentHash} />, 12);
  if (version.revision) add("hash-lines", <HashRow label="Agreed lines · SHA-256" hash={version.revision.contentHash} />, version.contentHash ? 0 : 12);
  add("verify", version.contentHash ? <div className="grid gap-3">
    <ol className="m-0 grid list-decimal gap-0.5 pl-5 text-[12px] text-[#4a4f45]">
      <li>Download the record (JSON) from this {signed ? "receipt" : "quote"} in Setti.</li>
      <li>Hash <span className="font-mono text-[11px]">version.document</span> as JSON with its keys sorted and no spaces.</li>
      <li>Compare the result with the version {version.number} fingerprint above.</li>
    </ol>
    <pre className="m-0 whitespace-pre-wrap break-all rounded border border-[var(--line)] bg-[#f4f3ef] px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-[#2c3129]">{verifyCommand(receipt.receiptNo)}</pre>
  </div> : draft ? <p className="text-[12px] text-[var(--muted)]">Setti fingerprints this version when you send it. The fingerprint and how to check it then appear here.</p> : <p className="text-[12px] text-[var(--muted)]">This version came with the demo, so it has no sent-document fingerprint. Setti recorded the fingerprint of its agreed lines when the project was set up.</p>, 12);

  add("notes", <div className="grid gap-1 text-[10.5px] leading-relaxed text-[var(--muted)]">
    <p>{signed ? "This receipt records the agreement as signed and the PayPal activity reported when it was issued. Money that moves later appears on a newer receipt. It is not a tax invoice."
      : draft ? `This is a preview of version ${version.number} before ${designer} sends it. ${project.client} receives exactly this quote, with the date it is sent. It is not a tax invoice.`
      : awaiting ? `This quote is version ${version.number} as ${designer} sent it. It becomes the agreement only when ${project.client} signs it; Setti then issues the signed version receipt. It is not a tax invoice.`
        : `This quote is version ${version.number} as ${designer} sent it. A newer version replaced it before ${project.client} signed it, so it is not an agreement. It is not a tax invoice.`}</p>
    <p>Not included: {receipt.notIncluded.join(", ")}. {demo ? "Demo project on PayPal Sandbox" : "PayPal Sandbox"}; no real money moved.</p>
  </div>);

  return { blocks, tables };
}

/**
 * A version's formal document on A4 sheets: its quote while the client has
 * not signed it, its signed version receipt after. `embedded` when it sits
 * beside other content, whose heading is the page's. `updating` while a
 * newer state of it is loading, so a signature just made never sits beside an
 * old "awaiting signature".
 */
export function ReceiptDocument({ receipt, studioName = "", embedded = false, decide, updating = false }: { receipt: VersionReceipt; studioName?: string; embedded?: boolean; decide?: OpeningDecide; updating?: boolean }) {
  const demo = useDemoMode();
  const { blocks, tables } = useMemo(() => receiptBlocks(receipt, studioName, demo, embedded, decide), [receipt, studioName, demo, embedded, decide]);
  const name = documentName(receipt);
  const sheets = <A4Sheets blocks={blocks} tables={tables} label={`${name}, No. ${receipt.receiptNo}`}
    footer={(page, pages) => <footer className="mt-4 flex justify-between gap-4 border-t border-[var(--line)] pt-2 text-[10px] leading-normal text-[var(--muted)]">
      <span>Setti · {name} · No. {receipt.receiptNo}</span>
      <span className="tabular-nums">Page {page} of {pages}</span>
    </footer>} />;
  return <div className="relative" aria-busy={updating || undefined}>
    {updating && <p role="status" className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg">
      <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />Updating the document…</p>}
    <div className={updating ? "opacity-50 transition-opacity" : "transition-opacity"}>{sheets}</div>
  </div>;
}
