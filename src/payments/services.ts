/**
 * Design services: one checkout holds every approved design service of the
 * current agreement at once, then each service is captured from that hold on
 * its own, so every line keeps its own PayPal capture (and any later refund).
 * No supplier confirms a studio's own service, so nothing waits for one. The
 * client must approve at least one design service before paying.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, revisions, savedPaymentMethods, servicesHoldLines } from "../db/schema";
import type { FundingPlan } from "../approval/funding";
import { fundingIdentities, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import { changeOrders, pricingCases } from "../pricing/schema";
import { attempt, checkoutDetails, type LinkBuilder } from "./actions";
import { createCheckout } from "./authorize";
import { confirmedPlan, lockConfirmedVersion, PaymentActionError, type Tx } from "./binding";
import { executeCapture } from "./capture";
import { lockOpeningVersion, openingPlan } from "./opening";
import { insertOperation, type OperationBinding, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agreement payment steps start from now, with its recorded money and plan. */
export interface PaymentBasis {
  projectId: string;
  version: number;
  /** The confirmed change order, or null for a V1 signed line by line. */
  orderId: string | null;
  /** Names the agreement in business keys: the change order, or the V1 revision. */
  key: string;
  /** The hash of the document the client confirmed: the change order, or the signed V1. */
  contentHash: string;
  ledger: ProjectLedger;
  plan: FundingPlan;
  /** The business item behind a plan line, if the agreement has it. */
  businessItem(line: { itemId: string; side: "baseline" | "proposed" }): string | undefined;
  bind(itemId: string | null): OperationBinding;
}

/**
 * Locks the case and loads the agreement payments start from: the V1 the client
 * signed while no newer version replaced it, otherwise the latest version the
 * client confirmed.
 */
export async function lockPaymentBasis(tx: Tx, sessionId: string, key: CaseKey): Promise<PaymentBasis> {
  if (!UUID.test(sessionId)) throw new PaymentActionError("FORBIDDEN", "Open this project from the browser that owns the demo case.");
  const [row] = await tx.select({ id: chatCases.id }).from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  const [bridge] = row ? await tx.select().from(pricingCases).where(eq(pricingCases.caseId, row.id)) : [];
  if (!row || !bridge) throw new PaymentActionError("NOT_CONFIRMED", "Payment steps start after the client approves the quote.");
  const [baseline] = await tx.select({ status: revisions.status }).from(revisions).where(eq(revisions.id, bridge.baselineRevisionId));

  if (baseline.status === "sent") {
    const version = await lockOpeningVersion(tx, sessionId, key, null);
    const { ledger, plan } = await openingPlan(tx, version);
    const approved = new Map(version.approved.map((entry) => [entry.line.itemId, entry.itemId]));
    return {
      projectId: version.projectId, version: 1, orderId: null, key: version.revisionId, contentHash: version.contentHash, ledger, plan,
      businessItem: (line) => line.side === "baseline" ? approved.get(line.itemId) : undefined, bind: version.bind,
    };
  }
  const [latest] = await tx.select({ id: changeOrders.id }).from(changeOrders).innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
    .where(and(eq(changeOrders.caseId, row.id), eq(revisions.status, "approved"))).orderBy(desc(revisions.number)).limit(1);
  if (!latest) throw new PaymentActionError("NOT_CONFIRMED", "Payment steps start after the client confirms a version.");
  const version = await lockConfirmedVersion(tx, sessionId, latest.id, null);
  const { ledger, plan } = await confirmedPlan(tx, version);
  const { byGroup } = fundingIdentities(version.order, version.itemMapping);
  return {
    projectId: version.projectId, version: version.order.version, orderId: version.order.id, key: version.order.id, contentHash: version.order.contentHash, ledger, plan,
    businessItem: (line) => byGroup.get(`${line.side}:${line.itemId}`), bind: version.bind,
  };
}

/** The approved design services the agreement still has to charge, with their business items. */
async function serviceCharges(tx: Tx, basis: PaymentBasis): Promise<{ itemId: string; amountCents: number }[]> {
  const kinds = new Map((await tx.select({ id: items.id, kind: items.kind }).from(items).where(eq(items.projectId, basis.projectId))).map((row) => [row.id, row.kind]));
  return basis.plan.actions.flatMap((action) => {
    const line = basis.plan.lines.find((entry) => entry.itemId === action.itemId && entry.side === action.side);
    const itemId = basis.businessItem(action);
    // Old-item costs of a replaced or removed line are not design services.
    const service = line && (line.change === null || line.change === "add" || line.change === "quantity");
    return action.kind === "capture" && action.timing === "on_payment_execution" && service && itemId && kinds.get(itemId) === "service" ? [{ itemId, amountCents: action.amountCents }] : [];
  });
}

/**
 * Client step: one PayPal checkout that holds every approved design service
 * still to be charged, split line by line, and saves PayPal for the project's
 * later holds unless it already has. A repeated click resumes the same checkout.
 */
export async function startServicesCheckout(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, links: LinkBuilder): Promise<PaymentOperation> {
  const operation = await db.transaction(async (tx) => {
    const basis = await lockPaymentBasis(tx, sessionId, key);
    const open = basis.ledger.operations.find((entry) => entry.servicesHold && (entry.status === "pending" || entry.status === "unknown"));
    if (open) return open;
    if (basis.plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before paying.", basis.plan.blockers);
    const split = await serviceCharges(tx, basis);
    if (!split.length) throw new PaymentActionError("NOT_AVAILABLE", "Approve at least one design service before paying. No design service is waiting to be charged.");
    const [saved] = await tx.select({ id: savedPaymentMethods.id }).from(savedPaymentMethods).where(eq(savedPaymentMethods.projectId, basis.projectId));
    const prefix = `services:${basis.key}:`;
    const created = await insertOperation(tx, {
      businessKey: `${prefix}${attempt(basis.ledger, "authorize", prefix)}`, projectId: basis.projectId, kind: "authorize",
      amountCents: split.reduce((total, line) => total + line.amountCents, 0), binding: basis.bind(null), servicesHold: true, savePaymentMethod: !saved,
    });
    await tx.insert(servicesHoldLines).values(split.map((line) => ({ operationId: created.id, ...line })));
    return created;
  });
  return createCheckout(db, paypal, operation, links(operation.id), await checkoutDetails(db, operation));
}

/**
 * After the design-services hold is authorized: captures each service's share
 * from it, one at a time (a hold takes one open money move at a time); the
 * last capture closes the hold. Stops at the first capture that did not
 * succeed; calling again resumes it.
 */
export async function chargeServices(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey): Promise<PaymentOperation[]> {
  const results: PaymentOperation[] = [];
  for (;;) {
    const next = await db.transaction(async (tx) => {
      const { ledger } = await lockPaymentBasis(tx, sessionId, key);
      const holdOperation = ledger.operations.filter((entry) => entry.servicesHold && entry.status === "succeeded").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const hold = holdOperation && ledger.authorizations.find((entry) => entry.operationId === holdOperation.id);
      if (!holdOperation || !hold) throw new PaymentActionError("NOT_AVAILABLE", "The design services have not been authorized on PayPal yet.");
      const open = ledger.operations.find((entry) => entry.kind === "capture" && entry.authorizationId === hold.id && (entry.status === "pending" || entry.status === "unknown"));
      if (open) return open;
      if (hold.status !== "created" && hold.status !== "partially_captured") return null;
      const left = ledger.servicesHoldLines.filter((line) => line.operationId === holdOperation.id).map((line) => ({
        itemId: line.itemId,
        cents: line.amountCents - ledger.captures.filter((capture) => capture.authorizationId === hold.id && capture.itemId === line.itemId && capture.status !== "declined").reduce((total, capture) => total + capture.amountCents, 0),
      })).filter((line) => line.cents > 0);
      if (!left.length) return null;
      const [line] = left;
      const prefix = `capture:${hold.id}:${line.itemId}:`;
      return insertOperation(tx, {
        businessKey: `${prefix}${attempt(ledger, "capture", prefix)}`, projectId: holdOperation.projectId, kind: "capture", authorizationId: hold.id,
        amountCents: line.cents, finalCapture: left.length === 1,
        binding: { changeOrderId: holdOperation.changeOrderId, revisionId: holdOperation.revisionId!, contentHash: holdOperation.contentHash!, revisionContentHash: holdOperation.revisionContentHash!, itemId: line.itemId },
      });
    });
    if (!next) return results;
    const done = await executeCapture(db, paypal, next.id);
    results.push(done);
    if (done.status !== "succeeded") return results;
  }
}
