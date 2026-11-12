import { and, desc, eq, inArray } from "drizzle-orm";
import { currentCaseQuote } from "../approval/baseline";
import { ledgerFacts, readLedger, type FundingIdentity, type ProjectLedger } from "../approval/store";
import { changeOrderDecisions } from "../approval/schema";
import { isCaseKey } from "../chat/cases";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { revisions } from "../db/schema";
import { changeOrders, pricingCases } from "../pricing/schema";
import { itemMappingKey } from "../pricing/document";
import { calculateLineTotals, calculateQuoteTotals } from "../quotes/totals";
import type { ApprovedQuoteReport } from "../quotes/types";
import { readOpening } from "../opening/read";
import { paypalCalls } from "../payments/schema";
import { trySeeds } from "../try/schema";
import { HOME_SCENARIO } from "../demo/living-dining";
import type { PaymentLineView, PaymentsWorkspace } from "../payments/types";
import { paymentsWorkspace } from "../payments/workspace";
import { feesText } from "../pricing/fees";
import type { FrozenChangeOrder, NonRefundableFee } from "../pricing/types";
import type { MoneyContext, MoneyFact, MoneyItem, MoneySource, MoneyStatus } from "./money-types";
import { quoteHref } from "../quotes/links";

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
  if (!UUID.test(sessionId) || !isCaseKey(key)) {
    throw new MoneyContextError("INVALID_MONEY_SCOPE", "Money evidence requires the owning project session.");
  }
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: chatCases.id, startsFrom: chatCases.startsFrom, quote: chatCases.quote }).from(chatCases)
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
      const quote = await currentCaseQuote(tx, owned.id);
      if (!quote) throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The client has not approved any line of quote V1 yet.");
      const opening = await readOpening(tx, owned);
      if (opening.revision && opening.opening.contentHash && opening.document.id === quote.id && quote.version === 1) {
        const [bridge] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, owned.id));
        if (!bridge || quote.lines.some((line) => opening.lines[line.itemId]?.state !== "approved" || opening.decisions.get(line.itemId)?.decision !== "approved")) throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The approved V1 and its signed line decisions could not be verified.");
        const ledger = await readLedger(tx, bridge.projectId);
        const operationIds = ledger.operations.map((operation) => operation.id);
        const calls = operationIds.length ? await tx.select({ createdAt: paypalCalls.createdAt, httpStatus: paypalCalls.httpStatus }).from(paypalCalls).where(inArray(paypalCalls.operationId, operationIds)) : [];
        const [seed] = await tx.select({ scenario: trySeeds.scenario, status: trySeeds.status }).from(trySeeds).where(eq(trySeeds.sessionId, sessionId));
        return bounded(openingMoneyContext({ key, quote, ledger, itemMapping: bridge.itemMapping, now,
          providerRecordedAt: calls.filter((call) => call.httpStatus !== null).map((call) => call.createdAt.toISOString()).sort().at(-1) ?? null,
          preparationStatus: seed?.scenario === HOME_SCENARIO ? seed.status : undefined,
        }));
      }
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
    const workspace = await paymentsWorkspace(tx, sessionId, order.id, now);
    if (!workspace || !workspace.current || !workspace.canAct) {
      throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The current approved payment evidence is unavailable.");
    }
    return bounded(contextFromWorkspace(key, order.id, order, decision.decidedAt.toISOString(), workspace, now));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

interface OpeningMoneyInput {
  key: CaseKey;
  quote: ApprovedQuoteReport;
  ledger: ProjectLedger;
  itemMapping: Readonly<Record<string, string>>;
  now: Date;
  providerRecordedAt: string | null;
  preparationStatus?: "seeding" | "ready" | "failed";
}

/** A real signed V1 has payment evidence without being a synthetic change order. */
export function openingMoneyContext({ key, quote, ledger, itemMapping, now, providerRecordedAt, preparationStatus }: OpeningMoneyInput): MoneyContext {
  const href = `/quotes/${key}`, paymentHref = `${href}#item-holds`;
  const sources: MoneySource[] = [
    { id: "quote", kind: "quote", label: `${quote.projectName} · approved V1 quote`, href, recordedAt: quote.approvedAt },
    { id: "approval", kind: "approval", label: "Client's recorded demo V1 confirmation", href, recordedAt: quote.approvedAt },
  ];
  const facts: MoneyFact[] = [
    fact("quote", `The client-approved scope of V1 totals ${usd(calculateQuoteTotals(quote.lines).totalCents)}. It remains the agreement while any revised proposal is unconfirmed. Quote approval is not a payment receipt.`, ["quote", "approval"]),
    fact("approval", `Demo client ${quote.approvedBy} confirmed the shown V1 scope at ${quote.approvedAt}. This records agreement, not a payment or a supplier order.`, ["quote", "approval"]),
  ];
  const mandatoryFactIds: string[] = [];
  const preparing = preparationStatus !== undefined && preparationStatus !== "ready";
  if (preparing) {
    facts.push(fact("payment-preparation", preparationStatus === "failed"
      ? "The demo's original payment preparation has stopped before completion. The project and discussion are available, but its intended starting holds and charges are not all established. Resume the same saved preparation; do not treat absent amounts as zero or settled and do not create replacement payments."
      : "The demo's original payment preparation is still in progress. The project and discussion are available before all starting holds and charges exist. The amounts below describe recorded results so far, not the final prepared history; do not treat absent amounts as zero or settled.", ["quote"]));
    mandatoryFactIds.push("payment-preparation");
  }
  const identities = new Map<string, FundingIdentity>();
  const mappingBlockers: string[] = [];
  for (const line of quote.lines) {
    const businessId = itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    if (businessId) identities.set(businessId, { itemId: line.itemId, side: "baseline" });
    else mappingBlockers.push(`The funding identity for ${line.name} is missing.`);
  }
  const recorded = ledgerFacts(identities, mappingBlockers, ledger, null, now);
  const totals = { held: 0, captured: 0, refunded: 0 };
  const items: MoneyItem[] = [];
  for (const line of quote.lines) {
    const businessId = itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    const held = recorded.lines.find((entry) => entry.itemId === line.itemId && entry.side === "baseline");
    const refs = ["quote", "approval"];
    const holds = ledger.authorizations.filter((entry) => entry.itemId === businessId || (!entry.itemId && ledger.servicesHoldLines.some((split) => split.itemId === businessId && split.operationId === entry.operationId)));
    const holdIds = new Set(holds.filter((entry) => entry.itemId === businessId).map((entry) => entry.id));
    const captures = ledger.captures.filter((entry) => entry.itemId === businessId || (entry.authorizationId && holdIds.has(entry.authorizationId)));
    const captureIds = new Set(captures.map((entry) => entry.id));
    const refunds = ledger.refunds.filter((entry) => captureIds.has(entry.captureId));
    function addSource(id: string, label: string, at: Date) {
      if (!sources.some((source) => source.id === id)) sources.push({ id, kind: "payment", label, href: line.category === "service" ? `${href}#design-services` : paymentHref, recordedAt: at.toISOString() });
      refs.push(id);
    }
    for (const hold of holds) addSource(`hold:${hold.id}`, `PayPal V1 authorization ${hold.paypalAuthorizationId} · ${hold.status}`, hold.createdAt);
    for (const capture of captures) addSource(`capture:${capture.id}`, `PayPal V1 capture ${capture.paypalCaptureId} · ${capture.status}`, capture.createdAt);
    for (const refund of refunds) addSource(`refund:${refund.id}`, `PayPal V1 refund ${refund.paypalRefundId} · ${refund.status}`, refund.createdAt);
    const itemFacts = [`item:baseline:${line.itemId}`, `next:baseline:${line.itemId}`];
    for (const event of ledger.supplierEvents.filter((entry) => entry.itemId === businessId)) {
      const id = `supplier:${event.id}`;
      sources.push({ id, kind: "supplier", label: `Demo V1 supplier ${event.kind} · ${event.reference}`, href: paymentHref, recordedAt: event.createdAt.toISOString() });
      refs.push(id);
      itemFacts.push(id);
      facts.push(fact(id, `${line.name}: a demo supplier ${event.kind === "credit_confirmed" ? "credit" : "confirmation"} for ${usd(event.totalCents)} was recorded by the designer. This is not a supplier integration or a PayPal receipt.`, [id, "quote"]));
    }
    const operations = ledger.operations.filter((entry) => entry.itemId === businessId || holds.some((hold) => hold.operationId === entry.id));
    const open = operations.filter((entry) => entry.status === "pending" || entry.status === "unknown");
    for (const operation of open) {
      const id = `operation:${operation.id}`;
      addSource(id, `${operation.kind} · ${operation.status} · ${operation.paypalResourceId ?? operation.paypalOrderId ?? operation.id}`, operation.updatedAt);
      if (!facts.some((entry) => entry.id === id)) facts.push(fact(id, `${operation.servicesHold ? "The design-services checkout" : line.name} has a V1 ${operation.kind} operation for ${usd(operation.amountCents)} whose outcome is ${operation.status}. Check the original operation; it is not proof that money completed or that a replacement is safe.`, [id]));
      mandatoryFactIds.push(id);
      itemFacts.push(id);
    }
    const heldCents = held?.heldCents ?? 0, capturedCents = held?.capturedCents ?? 0, refundedCents = held?.refundedCents ?? 0;
    totals.held += heldCents; totals.captured += capturedCents; totals.refunded += refundedCents;
    const target = calculateLineTotals(line).totalCents;
    facts.push(fact(`item:baseline:${line.itemId}`, `${line.name} (approved V1): the agreed target is ${usd(target)}; recorded held amount ${usd(heldCents)}, completed captures ${usd(capturedCents)}, completed refunds ${usd(refundedCents)}, net captured ${usd(capturedCents - refundedCents)}. A hold is not a charge, and another item's money does not pay this item.${preparing ? " Preparation is incomplete; these are records so far." : ""}`, refs));
    const uncertain = open.length > 0 || captures.some((entry) => entry.status === "pending") || refunds.some((entry) => entry.status === "pending");
    const nextId = `next:baseline:${line.itemId}`;
    const ordered = ledger.supplierEvents.some((entry) => entry.itemId === businessId && entry.kind === "order_confirmed");
    const next = uncertain ? "a provider outcome is pending or unknown. Reconcile the same operation before treating funds as completed."
      : preparing ? "the starting payment preparation is not finished. Missing payment records do not establish a final unpaid or settled balance."
      : capturedCents - refundedCents >= target ? "recorded net captures cover this agreed V1 target. This is this item's recorded state, not a full-project settlement."
      : heldCents > 0 ? line.category === "service" ? "the approved service amount is held but not charged yet. Service capture is a separate recorded step." : ordered ? "supplier confirmation is recorded, but the held amount is not captured yet." : "the amount is authorized, not charged; capture waits for this item's supplier confirmation."
      : `there is no completed recorded payment covering the remaining ${usd(Math.max(0, target - capturedCents + refundedCents))} target. Approval alone does not prove it was paid.`;
    facts.push(fact(nextId, `${line.name}: ${next}`, refs));
    if (uncertain) mandatoryFactIds.push(nextId);
    // A hold that is no longer open gave back whatever it did not capture.
    const capturedFrom = (holdId: string) => captures.filter((entry) => entry.authorizationId === holdId && entry.status === "completed").reduce((sum, entry) => sum + entry.amountCents, 0);
    const releasedCents = holds.filter((hold) => hold.itemId === businessId && hold.status !== "created" && hold.status !== "partially_captured")
      .reduce((sum, hold) => sum + Math.max(0, hold.amountCents - capturedFrom(hold.id)), 0);
    const money = { heldCents, capturedCents, refundedCents, releasedCents };
    items.push(moneyItem(`baseline:${line.itemId}`, line.name, money, 0, moneyStatus(money, { pending: uncertain, waitingCredit: false, refundDue: false }), itemFacts));
  }
  if (recorded.blockers?.length) {
    facts.push(fact("funding-blockers", `Recorded V1 payment evidence has unresolved conditions: ${recorded.blockers.join(" ")} No new executable payment conclusion follows from incomplete results.`, ["quote"]));
    mandatoryFactIds.push("funding-blockers");
  }
  facts.push(fact("scope", `For the approved V1 items only, the recorded totals are held ${usd(totals.held)}, completed captures ${usd(totals.captured)}, completed refunds ${usd(totals.refunded)}, net captured ${usd(totals.captured - totals.refunded)}.${preparing ? " Preparation is incomplete; these are recorded results so far." : ""} These are stored Sandbox records, not a complete settlement or live PayPal balance.`, [...new Set(sources.map((source) => source.id))]));
  facts.push(fact("record-freshness", `This answer reads stored V1 Sandbox evidence at ${now.toISOString()}; the most recent recorded provider response is ${providerRecordedAt ?? "unavailable"}. No live PayPal query was made for this answer.`, ["quote"]));
  if (!providerRecordedAt) {
    facts.push(fact("no-provider-records", "No stored PayPal response has yet been found for this V1. Quote and local preparation records do not establish actual completed payment or a PayPal balance.", ["quote"]));
    mandatoryFactIds.push("no-provider-records");
  }
  return { projectKey: key, quoteId: quote.id, version: 1, checkedAt: now.toISOString(), providerRecordedAt, mode: "recorded_sandbox", facts, sources, mandatoryFactIds: [...new Set(mandatoryFactIds)], items };
}

/** The item's state in fixed words, worked out from its records: anything still uncertain comes first. */
export function moneyStatus(money: { heldCents: number; capturedCents: number; refundedCents: number; releasedCents: number }, flags: { pending: boolean; waitingCredit: boolean; refundDue: boolean }): MoneyStatus {
  if (flags.pending) return "waiting_for_result";
  if (flags.waitingCredit) return "waiting_for_supplier_credit";
  if (flags.refundDue) return "refund_due";
  if (money.heldCents > 0) return "on_hold";
  if (money.refundedCents > 0) return "refunded";
  if (money.capturedCents > 0) return "charged";
  if (money.releasedCents > 0) return "released";
  return "not_charged";
}

function moneyItem(key: string, label: string, money: { heldCents: number; capturedCents: number; refundedCents: number; releasedCents: number }, nonRefundableCents: number, status: MoneyStatus, factIds: string[], nonRefundableFees: NonRefundableFee[] = []): MoneyItem {
  return {
    key, label, status, heldCents: money.heldCents, chargedCents: money.capturedCents, refundedCents: money.refundedCents, releasedCents: money.releasedCents,
    nonRefundableCents, nonRefundableFees: structuredClone(nonRefundableFees), netCents: money.capturedCents - money.refundedCents, factIds: [...new Set(factIds)],
  };
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
  const href = quoteHref(key, order.version);
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
  const items: MoneyItem[] = [];
  const openFacts = new Map<string, string[]>();
  const relevant = new Map(workspace.lines.filter((line) => line.businessItemId).map((line) => [line.businessItemId!, line]));
  for (const operation of workspace.operations) {
    for (const call of operation.calls) if (call.httpStatus !== null) providerTimes.push(call.createdAt);
    if (operation.status !== "pending" && operation.status !== "unknown") continue;
    const line = operation.businessItemId ? relevant.get(operation.businessItemId) : undefined;
    const id = `operation:${operation.id}`;
    sources.push({ id, kind: "payment", label: `${operation.kind} · ${operation.status} · ${operation.paypalResourceId ?? operation.paypalOrderId ?? operation.id}`, href: `${href}${line ? lineAnchor(line) : "#payments"}`, recordedAt: operation.updatedAt });
    facts.push(fact(id, `${operation.itemLabel ?? "An item"} has a ${operation.kind} operation for ${usd(operation.amountCents)} whose outcome is ${operation.status}. Check the existing operation; do not assume completion or start a replacement payment.`, [id]));
    mandatoryFactIds.push(id);
    if (operation.businessItemId) openFacts.set(operation.businessItemId, [...(openFacts.get(operation.businessItemId) ?? []), id]);
  }
  // A replaced item appears twice; the reader tells the two apart as the original and the new one.
  const replaced = new Set(workspace.lines.filter((line) => line.side === "proposed").map((line) => line.itemId));
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
    const itemFacts = [`item:${line.side}:${line.itemId}`, `next:${line.side}:${line.itemId}`, ...(line.businessItemId ? openFacts.get(line.businessItemId) ?? [] : [])];
    if (change) {
      facts.push(fact(`terms:${line.side}:${line.itemId}`, `${line.label}: the client-confirmed old-item handling is ${change.oldItemHandling}; the non-refundable cost is ${usd(change.oldItemCostCents)}${change.oldItemFees?.length ? `: ${feesText(change.oldItemFees)}` : ""}. This amount is already included in the confirmed target and must not be deducted a second time.`, ["quote", "approval"]));
      itemFacts.push(`terms:${line.side}:${line.itemId}`);
    }
    for (const event of line.supplierEvents) {
      const sourceId = `supplier:${event.id}`;
      sources.push({ id: sourceId, kind: "supplier", label: `Demo supplier ${event.kind} · ${event.reference}`, href: `${href}${lineAnchor(line)}`, recordedAt: event.createdAt });
      facts.push(fact(sourceId, `${line.label}: a demo ${event.kind === "credit_confirmed" ? "supplier credit" : "supplier confirmation"} for ${usd(event.totalCents)} was recorded by the designer at ${event.createdAt}. This is not a live supplier integration or a PayPal receipt.`, [sourceId, "quote"]));
      itemFacts.push(sourceId);
    }
    const pending = (line.businessItemId ? openFacts.has(line.businessItemId) : false) || line.captures.some((capture) => capture.status === "pending") || line.refunds.some((refund) => refund.status === "pending");
    const owed = net > line.targetCents;
    const waitingCredit = owed && !!line.refundRequiresSupplierCredit && !line.supplierEvents.some((event) => event.kind === "credit_confirmed");
    const money = { heldCents: line.heldCents, capturedCents: line.capturedCents, refundedCents: line.refundedCents, releasedCents: line.releasedCents };
    const label = line.side === "proposed" ? `${line.label} (new)` : replaced.has(line.itemId) ? `${line.label} (original)` : line.label;
    const kept = change && change.oldItemHandling !== "not_applicable" ? change.oldItemCostCents : 0;
    items.push(moneyItem(`${line.side}:${line.itemId}`, label, money, kept, moneyStatus(money, { pending, waitingCredit, refundDue: owed && !waitingCredit }), itemFacts, kept ? change?.oldItemFees : []));
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
  return { projectKey: key, quoteId, version: order.version, checkedAt: now.toISOString(), providerRecordedAt, mode: "recorded_sandbox", facts, sources, mandatoryFactIds, items };
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
