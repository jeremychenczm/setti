"use client";

import { ArrowLeft, FileText, ReceiptText } from "lucide-react";
import { useState } from "react";
import { STUDIO_STAGES, studioLineState, studioLineTotal, studioMoneyTotals, studioQuoteTotal, type StudioCase, type StudioQuote } from "@/demo/studio-types";
import { industryIcons } from "./DesignerProjects";
import styles from "./Studio.module.css";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const initials = (name: string) => name.split(" ").map((word) => word[0]).slice(0, 2).join("");
const quoteStatus = { approved: "Approved", draft: "Draft · not sent", awaiting_client: "Awaiting client", declined: "Declined · not in force" };

export function StudioProjectRecords({ project, initialTab = "quote", onBack, onSelectTab }: { project: StudioCase; initialTab?: "quote" | "payments"; onBack: () => void; onSelectTab?: (tab: "quote" | "payments") => void }) {
  const [tab, setTab] = useState<"quote" | "payments">(initialTab);
  const stage = STUDIO_STAGES[project.stage];
  const totals = studioMoneyTotals(project);
  const Icon = industryIcons[project.industry];
  const budget = project.proposal?.status === "awaiting_client" ? project.proposal : project.quote;
  return <main className={styles.module}>
    <header className={styles.moduleHeader}><div className={styles.breadcrumb}><button type="button" onClick={onBack}><ArrowLeft size={15} />Back to chat</button><span>/</span><strong>{project.name}</strong></div><span className={styles.preparedTag}>Prepared quote & payment records</span></header>
    <div className={styles.scrollArea}>
      <div className={styles.projectBody}>
        <div className={styles.projectHeading}><span className={styles.industryIcon}><Icon size={24} strokeWidth={1.5} /></span><div><p className={styles.eyebrow}>{project.industry}</p><h1>{project.name}</h1><p>{project.location}</p></div><span className={styles.status} data-tone={stage.tone}>{stage.label}</span></div>
        <p className={styles.historyNote}>Starting quotes, approvals and payment figures are prepared examples. New discussion stays in this project’s chat; these records do not change when a message is sent.</p>
        <div className={styles.projectColumns}>
          <section className={styles.workspace} aria-label={`${project.name} project history`}>
            <div className={styles.clientHeader}><span className={styles.clientAvatar}>{initials(project.client.name)}</span><div><strong>{project.client.name}</strong><p>{project.client.title} · project chat with Jordan</p></div></div>
            <div className={styles.tabs} role="tablist" aria-label="Project records">{([['quote', 'Quotes', FileText], ['payments', 'Payments', ReceiptText]] as const).map(([id, label, TabIcon]) => <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => onSelectTab ? onSelectTab(id) : setTab(id)}><TabIcon size={14} />{label}</button>)}</div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
              {tab === "quote" && <div className={styles.recordContent}>
                {project.proposal && <QuoteSheet title={project.proposal.status === "declined" ? "Declined proposal" : "Latest proposal"} quote={project.proposal} baseline={project.quote} />}
                <QuoteSheet title={project.quote.status === "draft" ? "Working draft" : project.proposal ? "Current approved scope" : "Current quote"} quote={project.quote} />
                <p className={styles.recordNote}>Prices, quantities, source schedules and client decisions are fictional prepared history. Tax is explicitly zero in these examples. Installation is excluded unless a line states otherwise.</p>
              </div>}
              {tab === "payments" && <div className={styles.recordContent}>
                <h2 className={styles.recordTitle}>Payment snapshot · V{project.quote.version}</h2><p className={styles.recordNote}>Illustrative history, not PayPal receipts. Held amounts reserve funds; paid amounts are captures minus refunds. A proposed or declined revision does not change the approved payment scope.</p>
                <div className={styles.moneyGrid}>{[{ label: "Held · not charged", value: totals.held }, { label: "Captured", value: totals.captured }, { label: "Refunded", value: totals.refunded }, { label: "Net paid", value: totals.netPaid }].map((item) => <div key={item.label}><span>{item.label}</span><strong>{money(item.value)}</strong></div>)}</div>
                <div className={styles.tableScroll}><table className={styles.moneyTable}><caption className="sr-only">Prepared payment history by item</caption><thead><tr><th>Item</th><th>State</th><th>Held</th><th>Net paid</th></tr></thead><tbody>{project.money.map((entry) => {
                  const item = project.quote.lines.find((line) => line.id === entry.lineId)!;
                  return <tr key={entry.lineId}><td><strong>{item.name}</strong><small>{item.kind}</small>{item.kind === "Retained cost" && <small>Agreed retained cost: {money(studioLineTotal(item))}</small>}</td><td>{studioLineState(project, entry)}{entry.awaitingCreditCents > 0 && <small>{money(entry.awaitingCreditCents)} credit needed</small>}{entry.refundedCents > 0 && <small>{money(entry.refundedCents)} refunded</small>}</td><td>{money(entry.heldCents)}</td><td>{money(entry.capturedCents - entry.refundedCents)}</td></tr>;
                })}</tbody></table></div>
                {totals.awaitingCredit > 0 && <div className={styles.pendingCredit}><strong>{money(totals.awaitingCredit)} awaits supplier credit</strong><p>Collection is recorded. A matching supplier credit is still required; this amount is not shown as refunded.</p></div>}
                <div className={styles.timeline}><h3>How the project reached this point</h3><ol>{project.timeline.map((event) => <li key={`${event.date}-${event.title}`}><time>{event.date}</time><div><strong>{event.title}</strong><p>{event.text}</p></div></li>)}</ol></div>
              </div>}
            </div>
          </section>

          <aside className={styles.summaryRail} aria-label="Project summary">
            <section className={styles.summaryCard}><p className={styles.eyebrow}>AT A GLANCE</p><h2>{stage.label}</h2><p>{stage.description}</p><dl><div><dt>{budget.status === "draft" ? "Draft estimate" : budget.status === "awaiting_client" ? `Proposed V${budget.version}` : `Approved V${budget.version}`}</dt><dd>{money(studioQuoteTotal(budget))}</dd></div><div><dt>Net paid · prepared</dt><dd>{money(totals.netPaid)}</dd></div><div><dt>Held · prepared</dt><dd>{money(totals.held)}</dd></div></dl>{project.proposal && <p className={styles.scopeNote}>V{project.quote.version} remains the approved scope. {project.proposal.status === "declined" ? "The declined proposal creates no new order or payment authority." : "The revision still needs the client's formal confirmation."}</p>}</section>
            <section className={styles.nextCard}><p className={styles.eyebrow}>NEXT / {project.next.actor.toUpperCase()}</p><h2>{project.next.title}</h2><p>{project.next.detail}</p><span className={styles.preparedTag}>Next step shown for context</span></section>

          </aside>
        </div>
      </div>
    </div>
  </main>;
}

function QuoteSheet({ title, quote, baseline }: { title: string; quote: StudioQuote; baseline?: StudioQuote }) {
  const total = studioQuoteTotal(quote);
  const difference = baseline ? total - studioQuoteTotal(baseline) : null;
  return <section className={styles.quoteSheet}><div className={styles.quoteHeading}><div><p className={styles.eyebrow}>{title}</p><h2>Quote V{quote.version}</h2></div><span className={styles.preparedTag}>{quoteStatus[quote.status]}</span></div>
    <div className={styles.tableScroll}><table className={styles.quoteTable}><caption className="sr-only">{title} V{quote.version} line items</caption><thead><tr><th>Scope &amp; specification</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr></thead><tbody>{quote.lines.map((line) => <tr key={line.id}><td><strong>{line.name}</strong><small>{line.kind}</small><p>{line.specification}</p></td><td>{line.quantity} {line.unit}</td><td>{money(line.unitPriceCents)}</td><td>{money(studioLineTotal(line))}</td></tr>)}</tbody><tfoot><tr><th colSpan={3}>V{quote.version} total · USD</th><td>{money(total)}</td></tr></tfoot></table></div>
    {difference !== null && <p className={styles.quoteDifference}>Change from approved V{baseline!.version}: <strong>{difference < 0 ? "−" : "+"}{money(Math.abs(difference))}</strong>. This is a quote difference, not a payment request.</p>}
    <p className={styles.recordNote}>{quote.note}</p>
    <details className={styles.sourceDetails}><summary>Prepared source schedule</summary><ul>{quote.lines.map((line) => <li key={line.id}>{line.name}<span>{line.source}</span></li>)}</ul><p>Fictional supplier references prepared for this example. No live supplier inventory or price lookup is implied.</p></details>
  </section>;
}
