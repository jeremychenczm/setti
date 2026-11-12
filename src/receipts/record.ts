/**
 * Reads one version's receipt from the records Setti already keeps: the version
 * as it was frozen, the client's signatures, and the PayPal steps for its items.
 * A sent version the client has not signed yet reads as its formal quote: the
 * same record with no signature.
 * This is the one place that gathers them, so the receipt page, the JSON
 * download and later dispute evidence all tell the same story. Nothing here
 * writes, infers a payment or makes a new fingerprint: amounts come from the
 * frozen documents and the ledger, fingerprints from the rows written when the
 * version was sent and signed.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { buildFundingPlan, buildOpeningPlan, type FundingPlan } from "../approval/funding";
import { changeOrderDecisions } from "../approval/schema";
import { fundingFactsFrom, fundingIdentities, ledgerFacts, readLedger, type FundingIdentity, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { approvals, items, revisionLines, revisions } from "../db/schema";
import { readOpening } from "../opening/read";
import { clientSignatureName } from "../opening/types";
import { lastConfirmation } from "../payments/money-events";
import { paypalCalls, paypalWebhookEvents } from "../payments/schema";
import { changeOrderContentHash, itemMappingKey } from "../pricing/document";
import { changeOrders, pricingCases } from "../pricing/schema";
import type { FrozenChangeOrder } from "../pricing/types";
import { approvedStart, preparedQuote } from "../projects/settings";
import type { LineSnapshot } from "../quotes/hash";
import { calculateLineTotals, calculateQuoteTotals } from "../quotes/totals";
import type { QuoteDocument } from "../quotes/types";
import {
  RECEIPT_FORMAT, RECEIPT_NOT_INCLUDED,
  type ChangeReceiptLine, type OpeningReceiptLine, type ReceiptItem, type ReceiptPayment, type ReceiptPending, type ReceiptSignature, type VersionReceipt,
} from "./types";

type Reader = Pick<Db, "select">;
type Bridge = typeof pricingCases.$inferSelect;
type OrderRow = typeof changeOrders.$inferSelect;
type DecisionRow = typeof changeOrderDecisions.$inferSelect;
type Operation = ProjectLedger["operations"][number];

export class ReceiptError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_SENT", message: string) { super(message); this.name = "ReceiptError"; }
}

/** The receipt of `version` in the session's project, or its formal quote while the client has not signed it. A version needs to be sent first. */
export async function readVersionReceipt(db: Db, sessionId: string, key: CaseKey, version: number, now = new Date()): Promise<VersionReceipt> {
  // One consistent snapshot: a payment recorded halfway through must not appear in one section and not another.
  return db.transaction(async (tx) => {
    const [caseRow] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
    if (!caseRow) throw new ReceiptError("NOT_FOUND", `This demo session has no version ${version} of the project.`);
    const [bridge] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, caseRow.id));
    const orders = await tx.select().from(changeOrders).where(eq(changeOrders.caseId, caseRow.id));
    const decisions = orders.length ? await tx.select().from(changeOrderDecisions).where(inArray(changeOrderDecisions.orderId, orders.map((order) => order.id))) : [];
    const versions = new Versions(orders, decisions);
    return version === 1
      ? openingReceipt(tx, caseRow, bridge ?? null, versions, now)
      : changeReceipt(tx, caseRow, bridge ?? null, versions, version, now);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The project's versions after V1, and which of them the client confirmed. */
class Versions {
  private readonly byOrder: Map<string, number>;
  private readonly confirmed: number[];
  constructor(readonly orders: OrderRow[], readonly decisions: DecisionRow[]) {
    this.byOrder = new Map(orders.map((order) => [order.id, order.document.version]));
    this.confirmed = orders.filter((order) => decisions.some((decision) => decision.orderId === order.id && decision.decision === "approved")).map((order) => order.document.version);
  }
  ofOrder(orderId: string): number | null { return this.byOrder.get(orderId) ?? null; }
  /** The first confirmed version after `version`, which replaced it. */
  replacing(version: number): number | null { return this.confirmed.filter((number) => number > version).sort((a, b) => a - b)[0] ?? null; }
}

function receiptItem(line: { itemId: string; name: string; vendor: string; sku: string; quantity: number; unitLabel?: string; unitPriceCents: number; taxCents: number; freightCents: number }): ReceiptItem {
  return { itemId: line.itemId, name: line.name, vendor: line.vendor, sku: line.sku, quantity: line.quantity, unitLabel: line.unitLabel ?? "each", totalCents: calculateLineTotals(line).totalCents };
}

async function revisionSnapshot(db: Reader, revisionId: string): Promise<{ status: string; contentHash: string; lines: LineSnapshot[] } | null> {
  const [revision] = await db.select().from(revisions).where(eq(revisions.id, revisionId));
  if (!revision?.contentHash) return null;
  const lines = await db.select().from(revisionLines).where(eq(revisionLines.revisionId, revisionId));
  return {
    status: revision.status, contentHash: revision.contentHash,
    lines: lines.map(({ itemId, quantity, unitPriceCents, taxCents, freightCents, restockingFeeBps, returnable, customMade, leadTimeDays }) => ({ itemId, quantity, unitPriceCents, taxCents, freightCents, restockingFeeBps, returnable, customMade, leadTimeDays }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
  };
}

function receiptNo(key: CaseKey, version: number, fingerprint: string | null): string {
  return `${key.toUpperCase()}-V${version}-${fingerprint ? fingerprint.slice(0, 8).toUpperCase() : "SAMPLE"}`;
}

function project(caseRow: CaseRow, document: Pick<QuoteDocument, "projectName" | "clientName" | "designerName">, bridge: Bridge | null): VersionReceipt["project"] {
  // Later versions keep the project but not the room line; it is the approved V1's, else the project's own V1's.
  return { key: caseRow.projectKey, name: document.projectName, room: bridge?.baselineQuote?.room ?? preparedQuote(caseRow).room, client: clientSignatureName(document), designer: document.designerName.replace(/\s*\(demo designer\)$/, "") };
}

type CaseRow = Pick<typeof chatCases.$inferSelect, "id" | "projectKey" | "startsFrom" | "quote">;

async function openingReceipt(db: Reader, caseRow: CaseRow, bridge: Bridge | null, versions: Versions, now: Date): Promise<VersionReceipt> {
  const key = caseRow.projectKey;
  const read = await readOpening(db, caseRow);
  const sample = !!read.approval;
  if (!sample && !read.opening.sentAt) throw new ReceiptError("NOT_SENT", "Quote V1 has not been sent to the client yet.");
  const document = read.document;
  const revision = bridge ? await revisionSnapshot(db, bridge.baselineRevisionId) : null;

  const signatures: ReceiptSignature[] = [];
  if (sample) {
    // A V1 approved before Setti carries its own approval, never a signature typed in Setti.
    const quote = bridge?.baselineQuote ?? approvedStart(caseRow)!;
    const imported = bridge ? await db.select().from(approvals).where(eq(approvals.revisionId, bridge.baselineRevisionId)) : [];
    const recorded = imported[0];
    signatures.push({
      method: "sample", signingId: null, name: recorded?.approverName ?? quote.approvedBy, signature: recorded?.signature ?? quote.signature,
      at: recorded?.decidedAt.toISOString() ?? new Date(quote.approvedAt).toISOString(), decision: "approved", note: null,
      itemIds: document.lines.map((line) => line.itemId), contentHash: null, revisionContentHash: recorded?.contentHash ?? null,
      matches: recorded && revision ? imported.every((row) => row.contentHash === revision.contentHash) : null,
    });
  } else {
    const bySigning = new Map<string, { itemId: string; row: typeof approvals.$inferSelect }[]>();
    for (const line of document.lines) {
      const row = read.decisions.get(line.itemId);
      if (!row?.signingId) continue;
      bySigning.set(row.signingId, [...(bySigning.get(row.signingId) ?? []), { itemId: line.itemId, row }]);
    }
    for (const [signingId, decided] of bySigning) {
      const first = decided.reduce((earliest, entry) => entry.row.decidedAt < earliest.row.decidedAt ? entry : earliest);
      const kinds = new Set(decided.map((entry) => entry.row.decision));
      signatures.push({
        method: "signed", signingId, name: first.row.approverName, signature: first.row.signature, at: first.row.decidedAt.toISOString(),
        decision: kinds.size > 1 ? "mixed" : decided[0].row.decision, note: null, itemIds: decided.map((entry) => entry.itemId),
        // The client signs against the V1 they read; Setti records the agreed lines' fingerprint with each decision.
        contentHash: null, revisionContentHash: first.row.contentHash,
        matches: !!revision && decided.every((entry) => entry.row.contentHash === revision.contentHash),
      });
    }
    signatures.sort((a, b) => a.at.localeCompare(b.at));
  }

  const lines: OpeningReceiptLine[] = document.lines.map((line) => {
    const state = read.lines[line.itemId];
    return { ...receiptItem(line), decision: state.state, note: state.note, decidedAt: state.decidedAt, decidedBy: state.by, signingId: read.decisions.get(line.itemId)?.signingId ?? null };
  });
  const decided = lines.filter((line) => line.decision === "approved" || line.decision === "declined");
  const approvedCount = lines.filter((line) => line.decision === "approved").length;
  const replacedBy = versions.replacing(1);

  // Business items of the V1 lines, for the payment record.
  const scope = new Map<string, FundingIdentity>();
  if (bridge) for (const line of document.lines) {
    const businessId = bridge.itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    if (businessId) scope.set(businessId, { itemId: line.itemId, side: "baseline" });
  }
  const ledger = bridge ? await readLedger(db, bridge.projectId) : null;

  let pending: ReceiptPending | null = null;
  if (ledger && bridge && revision && !sample && !replacedBy && revision.status === "sent" && read.opening.contentHash) {
    const approved = document.lines.filter((line) => read.lines[line.itemId].state === "approved" && read.decisions.get(line.itemId)?.decision === "approved");
    const identities = new Map([...scope].filter(([, identity]) => approved.some((line) => line.itemId === identity.itemId)));
    const plan = buildOpeningPlan({ id: bridge.baselineRevisionId, contentHash: read.opening.contentHash },
      approved.map((line) => ({ itemId: line.itemId, label: line.name, category: line.category, targetCents: calculateLineTotals(line).totalCents })),
      ledgerFacts(identities, [], ledger, null, now));
    pending = pendingOf(plan);
  }

  const fingerprint = read.opening.contentHash ?? revision?.contentHash ?? null;
  return {
    format: RECEIPT_FORMAT, receiptNo: receiptNo(key, 1, fingerprint), issuedAt: now.toISOString(), project: project(caseRow, document, bridge),
    version: {
      number: 1, basedOn: null,
      status: !signatures.length ? replacedBy ? "superseded" : "awaiting_signature"
        : approvedCount === 0 ? "declined" : approvedCount === lines.length ? "approved" : "partly_approved",
      replacedBy, sentAt: read.opening.sentAt, sentBy: read.opening.sentBy, contentHash: read.opening.contentHash, document,
      revision: revision && { contentHash: revision.contentHash, lines: revision.lines },
    },
    signatures,
    agreement: { kind: "opening", lines },
    totals: { previousCents: null, totalCents: calculateQuoteTotals(document.lines).totalCents, differenceCents: null },
    payments: ledger && bridge ? await payments(db, ledger, bridge, versions, scope, 1) : [],
    pending: decided.length ? pending : null,
    notIncluded: RECEIPT_NOT_INCLUDED,
  };
}

async function changeReceipt(db: Reader, caseRow: CaseRow, bridge: Bridge | null, versions: Versions, version: number, now: Date): Promise<VersionReceipt> {
  const key = caseRow.projectKey;
  const row = versions.orders.find((order) => order.document.version === version);
  if (!row) throw new ReceiptError("NOT_FOUND", `This project has no version ${version}.`);
  // Every later version is sent when it is frozen; until the client decides, it has no signature.
  const decision = versions.decisions.find((entry) => entry.orderId === row.id);
  const order: FrozenChangeOrder = row.document;
  const { contentHash, ...document } = order;
  const revision = await revisionSnapshot(db, row.revisionId);
  const approved = decision?.decision === "approved";
  const replacedBy = versions.replacing(version);

  const signature: ReceiptSignature | null = decision ? {
    method: "signed", signingId: null, name: decision.clientName, signature: decision.signature, at: decision.decidedAt.toISOString(),
    decision: decision.decision, note: decision.note.trim() || null, itemIds: [],
    contentHash: decision.contentHash, revisionContentHash: decision.revisionContentHash,
    // The signature, the stored version and its recomputed hash must all agree; a mismatch is reported, never hidden.
    matches: decision.contentHash === row.contentHash && row.contentHash === contentHash && changeOrderContentHash(document) === contentHash
      && decision.revisionContentHash === order.revisionContentHash && revision?.contentHash === order.revisionContentHash,
  } : null;

  // Changes read in the order of the version's lines, as the designer arranged them; a removed line comes last.
  const position = new Map(order.lines.map((line, index) => [line.itemId, index]));
  const at = (change: (typeof order.changes)[number]) => position.get(change.after?.itemId ?? "") ?? position.get(change.itemId ?? "") ?? order.lines.length;
  const changes: ChangeReceiptLine[] = [...order.changes].sort((a, b) => at(a) - at(b)).map((change) => ({
    itemId: change.itemId, action: change.action,
    before: change.before ? receiptItem(change.before) : null,
    after: change.after ? receiptItem(change.after) : null,
    oldItem: change.oldItemHandling === "not_applicable" ? null : { handling: change.oldItemHandling, retainedCents: change.oldItemCostCents, fees: change.oldItemFees ?? [], note: change.oldItemNote },
  }));

  let scope = new Map<string, FundingIdentity>();
  let ledger: ProjectLedger | null = null;
  let pending: ReceiptPending | null = null;
  if (bridge) {
    scope = fundingIdentities(order, bridge.itemMapping).byBusiness;
    ledger = await readLedger(db, bridge.projectId);
    if (approved && !replacedBy) pending = pendingOf(buildFundingPlan(order, fundingFactsFrom(order, bridge.itemMapping, ledger, now)));
  }

  return {
    format: RECEIPT_FORMAT, receiptNo: receiptNo(key, version, contentHash), issuedAt: now.toISOString(), project: project(caseRow, order, bridge),
    version: {
      number: version, basedOn: order.basedOnVersion, replacedBy,
      status: decision ? approved ? "approved" : "changes_requested" : revision?.status === "superseded" || replacedBy ? "superseded" : "awaiting_signature",
      sentAt: row.issuedAt.toISOString(), sentBy: order.designerName.replace(/\s*\(demo designer\)$/, ""), contentHash, document,
      revision: revision && { contentHash: revision.contentHash, lines: revision.lines },
    },
    signatures: signature ? [signature] : [],
    agreement: {
      kind: "change", changes,
      unchanged: order.lines.filter((line) => line.origin === "unchanged").map(receiptItem),
      source: { kind: order.source?.kind ?? null, vendor: order.source?.vendor ?? "", notice: order.source?.notice ?? "", messages: order.sourceMessages.map(({ id, actor, text, createdAt }) => ({ id, actor, text, createdAt })) },
      terms: order.terms,
    },
    totals: { previousCents: order.baselineTotals.totalCents, totalCents: order.totals.totalCents, differenceCents: order.deltaTotalCents },
    payments: ledger && bridge ? await payments(db, ledger, bridge, versions, scope, version) : [],
    pending,
    notIncluded: RECEIPT_NOT_INCLUDED,
  };
}

function pendingOf(plan: FundingPlan): ReceiptPending {
  return {
    actions: plan.actions.map(({ kind, itemId, side, label, amountCents, timing, reason }) => ({ kind, itemId, side, label, amountCents, timing, reason })),
    blockers: [...plan.blockers],
    position: { ...plan.current },
  };
}

/**
 * The PayPal steps for the items of `version`: its own steps, and those earlier
 * versions took on the same items, brought forward. A later version's steps
 * belong to that version's receipt.
 */
async function payments(db: Reader, ledger: ProjectLedger, bridge: Bridge, versions: Versions, scope: ReadonlyMap<string, FundingIdentity>, version: number): Promise<ReceiptPayment[]> {
  const done = ledger.operations.filter((operation) => operation.status === "succeeded");
  if (!done.length) return [];
  const holds = new Map(ledger.authorizations.map((hold) => [hold.id, hold]));
  const byId = new Map(ledger.operations.map((operation) => [operation.id, operation]));
  const ownVersion = (operation: Operation | undefined): number | null => !operation ? null
    : operation.changeOrderId ? versions.ofOrder(operation.changeOrderId)
      : operation.revisionId === bridge.baselineRevisionId ? 1 : null;
  // A step on a hold that carries no version of its own belongs to the version that placed the hold.
  const versionOf = (operation: Operation) => ownVersion(operation)
    ?? (operation.authorizationId ? ownVersion(byId.get(holds.get(operation.authorizationId)?.operationId ?? "")) : null);
  // The design-services hold pays for several services at once.
  const servicesOf = (operationId: string | null | undefined) => ledger.servicesHoldLines.filter((line) => line.operationId === operationId).map((line) => line.itemId);
  const businessItems = (operation: Operation): string[] => {
    const capture = operation.kind === "capture" ? ledger.captures.find((entry) => entry.operationId === operation.id) : undefined;
    const hold = operation.authorizationId ? holds.get(operation.authorizationId) : undefined;
    const single = capture?.itemId ?? operation.itemId ?? hold?.itemId;
    if (single) return [single];
    return servicesOf(operation.servicesHold ? operation.id : hold?.operationId);
  };

  const ids = done.map((operation) => operation.id);
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.projectId, bridge.projectId))).map((row) => [row.id, row.name]));
  const calls = await db.select().from(paypalCalls).where(and(inArray(paypalCalls.operationId, ids), eq(paypalCalls.outcome, "ok"))).orderBy(desc(paypalCalls.createdAt));
  const pushed = await db.select().from(paypalWebhookEvents).where(inArray(paypalWebhookEvents.operationId, ids)).orderBy(desc(paypalWebhookEvents.receivedAt));

  return done.flatMap((operation): ReceiptPayment[] => {
    const stepVersion = versionOf(operation);
    if (stepVersion === null || stepVersion > version) return [];
    const business = businessItems(operation).filter((id) => scope.has(id));
    if (!business.length) return [];
    const hold = operation.authorizationId ? holds.get(operation.authorizationId) : undefined;
    const resource = operation.paypalResourceId ?? undefined;
    const step = {
      authorize: { action: operation.replacesAuthorizationId ? "renewed" as const : "held" as const, paypal: { authorizationId: resource } },
      reauthorize: { action: "renewed" as const, paypal: { authorizationId: resource } },
      capture: { action: "charged" as const, paypal: { captureId: resource } },
      void: { action: "released" as const, paypal: { authorizationId: hold?.paypalAuthorizationId } },
      refund: { action: "refunded" as const, paypal: { refundId: resource } },
    }[operation.kind];
    const single = business.length === 1 ? business[0] : null;
    return [{
      at: operation.updatedAt.toISOString(),
      itemId: single ? scope.get(single)!.itemId : null,
      item: single ? names.get(single) ?? "An item" : "Design services",
      action: step.action, amountCents: operation.amountCents,
      paypal: Object.fromEntries(Object.entries(step.paypal).filter(([, value]) => value)) as ReceiptPayment["paypal"],
      version: stepVersion, broughtForward: stepVersion < version,
      confirmed: lastConfirmation(operation.id, calls, pushed),
    }];
  }).sort((a, b) => a.at.localeCompare(b.at));
}
