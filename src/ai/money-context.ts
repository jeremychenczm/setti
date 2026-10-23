import { and, desc, eq } from "drizzle-orm";
import { approvedQuoteFromOrder, currentCaseQuote } from "../approval/baseline";
import { changeOrderDecisions } from "../approval/schema";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { revisions } from "../db/schema";
import { changeOrders } from "../pricing/schema";
import { calculateQuoteTotals } from "../quotes/totals";
import type { PaymentLineView, PaymentsWorkspace } from "../payments/types";
import { paymentsWorkspace } from "../payments/workspace";
import type { FrozenChangeOrder } from "../pricing/types";
import type { MoneyContext, MoneyFact, MoneySource } from "./money-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const signed = (cents: number) => `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;

export class MoneyContextError extends Error {
  constructor(readonly code: "INVALID_MONEY_SCOPE" | "MONEY_EVIDENCE_UNAVAILABLE" | "MONEY_CONTEXT_LIMIT", message: string) {
    super(message);
    this.name = "MoneyContextError";
  }
}

/** No model, provider call, write, or case creation occurs while reading evidence. */
export async function readCaseMoneyContext(db: Db, sessionId: string, key: CaseKey): Promise<MoneyContext> {
  if (!UUID.test(sessionId) || !["willow", "maple"].includes(key)) {
    throw new MoneyContextError("INVALID_MONEY_SCOPE", "Money evidence requires the owning project session.");
  }
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: chatCases.id }).from(chatCases)
      .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
    if (!owned) throw new MoneyContextError("INVALID_MONEY_SCOPE", "Money evidence requires the owning project session.");
    const [approved] = await tx.select({ document: changeOrders.document, decision: changeOrderDecisions })
      .from(changeOrders)
      .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
      .innerJoin(changeOrderDecisions, and(eq(changeOrderDecisions.orderId, changeOrders.id), eq(changeOrderDecisions.revisionId, revisions.id)))
      .where(and(eq(changeOrders.caseId, owned.id), eq(changeOrderDecisions.decision, "approved")))
      .orderBy(desc(revisions.number)).limit(1);
    const now = new Date();
    if (!approved) {
      const quote = await currentCaseQuote(tx, owned.id, key);
      if (!quote) throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The client has not approved any line of quote V1 yet.");
      const source: MoneySource = { id: "quote", kind: "quote", label: `${quote.projectName} · V${quote.version} demo quote`, href: `/quotes/${key}`, recordedAt: quote.approvedAt };
      return bounded({
        projectKey: key, quoteId: quote.id, version: quote.version, checkedAt: now.toISOString(), providerRecordedAt: null, mode: "recorded_sandbox",
        sources: [source], mandatoryFactIds: ["no-payment-records"], facts: [
          fact("quote", `The initial demo-approved V${quote.version} quote totals ${usd(calculateQuoteTotals(quote.lines).totalCents)}. A quote approval is not a payment receipt.`, [source.id]),
          fact("no-payment-records", "No client-confirmed change order with payment evidence was found in this case. Payment, authorization and refund amounts are not established by the quote or by chat; do not assume they are zero or paid.", [source.id]),
        ],
      });
    }
    const { document: order, decision } = approved;
    if (decision.sessionId !== sessionId || decision.contentHash !== order.contentHash || decision.revisionContentHash !== order.revisionContentHash) {
      throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The approved version and its decision could not be verified.");
    }
    const quote = approvedQuoteFromOrder(order, decision);
    const workspace = await paymentsWorkspace(tx, sessionId, order.id, now);
    if (!workspace || !workspace.current || !workspace.canAct) {
      throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The current approved payment evidence is unavailable.");
    }
    return bounded(contextFromWorkspace(key, quote.id, order, decision.decidedAt.toISOString(), workspace, now));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function fact(id: string, en: string, sourceIds: string[]): MoneyFact {
  return { id, text: { en }, sourceIds: [...new Set(sourceIds)] };
}

function bounded(context: MoneyContext): MoneyContext {
  if (context.facts.length > 160 || context.sources.length > 500 || JSON.stringify(context).length > 100_000) {
    throw new MoneyContextError("MONEY_CONTEXT_LIMIT", "This case has more money evidence than this answer can safely include. No evidence was silently omitted.");
  }
  return context;
}

function contextFromWorkspace(key: CaseKey, quoteId: string, order: FrozenChangeOrder, approvedAt: string, workspace: PaymentsWorkspace, now: Date): MoneyContext {
  const href = `/change-orders/${order.id}`;
  const sources: MoneySource[] = [
    { id: "quote", kind: "quote", label: `Client-confirmed V${order.version} quote`, href, recordedAt: order.issuedAt },
    { id: "approval", kind: "approval", label: `Client confirmation · V${order.version}`, href, recordedAt: approvedAt },
  ];
  const mandatoryFactIds = ["record-freshness"];
  const facts: MoneyFact[] = [
    fact("budget", `The client-confirmed V${order.version} quote is ${usd(order.totals.totalCents)}, compared with ${usd(order.baselineTotals.totalCents)} in V${order.basedOnVersion}; the budget change is ${signed(order.deltaTotalCents)}. This difference is not an amount already charged or a checkout amount.`, ["quote", "approval"]),
    fact("approval", `The demo client confirmed this frozen V${order.version} on ${approvedAt}. Scope approval and PayPal buyer authorization are separate; the AI cannot approve or move money.`, ["approval"]),
  ];
  const lineSources = new Map<string, string[]>();
  const providerTimes: string[] = [];
  const relevant = new Map(workspace.lines.filter((line) => line.businessItemId).map((line) => [line.businessItemId!, line]));
  for (const operation of workspace.operations) {
    for (const call of operation.calls) if (call.httpStatus !== null) providerTimes.push(call.createdAt);
    if (operation.status !== "pending" && operation.status !== "unknown") continue;
    const line = operation.businessItemId ? relevant.get(operation.businessItemId) : undefined;
    const id = `operation:${operation.id}`;
    sources.push({ id, kind: "payment", label: `${operation.kind} · ${operation.status} · ${operation.paypalResourceId ?? operation.paypalOrderId ?? operation.id}`, href: `${href}${line ? lineAnchor(line) : "#payments"}`, recordedAt: operation.updatedAt });
    facts.push(fact(id, `${operation.itemLabel ?? "An item"} has a ${operation.kind} operation for ${usd(operation.amountCents)} whose outcome is ${operation.status}. Check the existing operation; do not assume completion or start a replacement payment.`, [id]));
    mandatoryFactIds.push(id);
  }
  for (const line of workspace.lines) {
    const refs = addLineSources(line, href, sources);
    lineSources.set(`${line.side}:${line.itemId}`, refs);
    const net = line.capturedCents - line.refundedCents;
    const newPurchase = line.side === "proposed" && ["replace", "add"].includes(line.change ?? "");
    facts.push(fact(`item:${line.side}:${line.itemId}`, `${line.label} (${line.side}): this version's target is ${usd(line.targetCents)}; currently held ${usd(line.heldCents)}, completed captures ${usd(line.capturedCents)}, completed refunds ${usd(line.refundedCents)}, released authorization ${usd(line.releasedCents)}, net captured ${usd(net)}. A released authorization is not a refund of captured money.${newPurchase ? " This new purchase has its own authorization; another item's released hold or refund does not pay for this authorization." : ""}`, refs));
    addNextFact(line, workspace, refs, facts);
    if (line.captures.some((capture) => capture.status === "pending") || line.refunds.some((refund) => refund.status === "pending")) {
      mandatoryFactIds.push(`next:${line.side}:${line.itemId}`);
    }
    const change = line.side === "baseline" ? order.changes.find((entry) => entry.itemId === line.itemId) : undefined;
    if (change) {
      facts.push(fact(`terms:${line.side}:${line.itemId}`, `${line.label}: the client-confirmed old-item handling is ${change.oldItemHandling}; the retained old-item cost is ${usd(change.oldItemCostCents)}. This amount is already included in the confirmed target and must not be deducted a second time.`, ["quote", "approval"]));
    }
    for (const event of line.supplierEvents) {
      const sourceId = `supplier:${event.id}`;
      sources.push({ id: sourceId, kind: "supplier", label: `Demo supplier ${event.kind} · ${event.reference}`, href: `${href}${lineAnchor(line)}`, recordedAt: event.createdAt });
      facts.push(fact(sourceId, `${line.label}: a demo ${event.kind === "credit_confirmed" ? "supplier credit" : "supplier confirmation"} for ${usd(event.totalCents)} was recorded by the designer at ${event.createdAt}. This is not a live supplier integration or a PayPal receipt.`, [sourceId, "quote"]));
    }
  }
  if (workspace.lines.length) {
    const totals = workspace.lines.reduce((sum, line) => ({ held: sum.held + line.heldCents, captured: sum.captured + line.capturedCents, refunded: sum.refunded + line.refundedCents, released: sum.released + line.releasedCents }), { held: 0, captured: 0, refunded: 0, released: 0 });
    facts.push(fact("scope", `For the shown payment items only: held ${usd(totals.held)}, completed captures ${usd(totals.captured)}, completed refunds ${usd(totals.refunded)}, released authorization ${usd(totals.released)}, net captured ${usd(totals.captured - totals.refunded)}. These are recorded Sandbox results, not a complete project settlement or a real-time PayPal balance. Pending results are not completed money.`, [...new Set([...lineSources.values()].flat())]));
  } else {
    facts.push(fact("no-payment-records", "There are no displayed item payment records for this confirmed version. Approval does not prove payment; no full-project payment conclusion can be drawn.", ["quote", "approval"]));
    mandatoryFactIds.push("no-payment-records");
  }
  if (workspace.others.lineCount) {
    const included = new Set(workspace.plan?.lines.filter((line) => workspace.lines.some((shown) => shown.itemId === line.itemId && shown.side === line.side)).map((line) => `${line.side}:${line.itemId}`));
    const outside = workspace.plan?.lines.filter((line) => !included.has(`${line.side}:${line.itemId}`)) ?? [];
    const names = outside.map((line) => `${line.label} ${usd(line.targetCents)}`).join("; ");
    facts.push(fact("outside-scope", `${workspace.others.lineCount} unchanged quote line(s), totaling ${usd(workspace.others.targetCents)}, are outside these payment steps${names ? `: ${names}` : ""}. No payments are recorded for those lines in this workspace. Do not claim their quote amount has been paid or add it to shown net captures.`, ["quote"]));
    mandatoryFactIds.push("outside-scope");
  }
  if (workspace.plan?.status === "blocked") {
    facts.push(fact("funding-blockers", "The funding plan is blocked by incomplete or uncertain records. Displayed recorded amounts do not make the plan executable; reconcile existing operations and resolve the recorded blockers before starting any new money step.", ["quote", ...sources.filter((source) => source.id.startsWith("operation:")).map((source) => source.id)]));
    mandatoryFactIds.push("funding-blockers");
  }
  const providerRecordedAt = providerTimes.sort().at(-1) ?? null;
  facts.push(fact("record-freshness", `This answer reads stored Sandbox evidence at ${now.toISOString()}; the most recent recorded provider response is ${providerRecordedAt ?? "unavailable"}. No live PayPal query was made for this answer. Supplier confirmations are designer-entered demo records.`, ["quote"]));
  if (!providerRecordedAt) {
    facts.push(fact("no-provider-records", "No stored PayPal response was found for this case. The displayed coverage is based on local records only and does not establish an actual PayPal balance or a completed payment.", ["quote"]));
    mandatoryFactIds.push("no-provider-records");
  }
  return { projectKey: key, quoteId, version: order.version, checkedAt: now.toISOString(), providerRecordedAt, mode: "recorded_sandbox", facts, sources, mandatoryFactIds };
}

function lineAnchor(line: PaymentLineView): string {
  return `#payment-line-${line.side}-${encodeURIComponent(line.itemId)}`;
}

function addLineSources(line: PaymentLineView, href: string, sources: MoneySource[]): string[] {
  const refs = ["quote", "approval"];
  for (const hold of line.holds) {
    const id = `hold:${hold.id}`;
    sources.push({ id, kind: "payment", label: `PayPal authorization ${hold.paypalAuthorizationId} · ${hold.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: hold.createdAt });
    refs.push(id);
  }
  for (const capture of line.captures) {
    const id = `capture:${capture.id}`;
    sources.push({ id, kind: "payment", label: `PayPal capture ${capture.paypalCaptureId} · ${capture.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: capture.createdAt });
    refs.push(id);
  }
  for (const refund of line.refunds) {
    const id = `refund:${refund.id}`;
    sources.push({ id, kind: "payment", label: `PayPal refund ${refund.paypalRefundId} · ${refund.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: refund.createdAt });
    refs.push(id);
  }
  return refs;
}

function addNextFact(line: PaymentLineView, workspace: PaymentsWorkspace, refs: string[], facts: MoneyFact[]): void {
  const id = `next:${line.side}:${line.itemId}`;
  const open = workspace.operations.filter((operation) => !!line.businessItemId && operation.businessItemId === line.businessItemId && ["pending", "unknown"].includes(operation.status));
  const add = (en: string, extra: string[] = []) => facts.push(fact(id, `${line.label}: ${en}`, [...refs, ...extra]));
  if (open.length || line.captures.some((capture) => capture.status === "pending") || line.refunds.some((refund) => refund.status === "pending")) {
    add("a payment result is pending or unknown. Check the existing operation before treating it as completed or starting another step.", open.map((operation) => `operation:${operation.id}`));
    return;
  }
  const net = line.capturedCents - line.refundedCents;
  if (net > line.targetCents) {
    const waitingCredit = line.refundRequiresSupplierCredit && !line.supplierEvents.some((event) => event.kind === "credit_confirmed");
    add(waitingCredit
      ? `${usd(net - line.targetCents)} remains to be refunded after the supplier credit is confirmed; it has not been returned yet. Another item's supplier confirmation does not satisfy this condition.`
      : `${usd(net - line.targetCents)} remains to be refunded from completed captures, subject to the current funding blockers; it has not been returned yet.`);
  } else if (line.heldCents > 0 && net >= line.targetCents) {
    add(`${usd(line.heldCents)} of unused authorization remains to be released; releasing it is not a refund.`);
  } else if (net + line.heldCents < line.targetCents) {
    add(`the approved target is still short of ${usd(line.targetCents - net - line.heldCents)} in recorded coverage. Its own additional authorization or payment is needed; a quote budget difference or another item's released hold does not pay for it.`);
  } else if (line.heldCents > 0) {
    const ordered = line.supplierEvents.some((event) => event.kind === "order_confirmed");
    add(ordered ? "the supplier confirmation has been recorded, but the held amount is not captured yet." : "the amount is authorized, not charged. Capture waits for this item's supplier confirmation.");
  } else {
    add(`recorded net captures match the approved target of ${usd(line.targetCents)} and no authorization remains. This only describes this item's recorded state.`);
  }
}
