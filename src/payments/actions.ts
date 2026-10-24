/**
 * Business entry points for payment steps. Each one goes through the common
 * entry (`lockConfirmedVersion`), takes its amount from the funding plan of
 * recorded facts (never from the request), and writes one operation per
 * business event, so a repeated click or a second window resumes the same
 * operation. PayPal is called only after the case lock is released.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, paymentOperations, paypalCaptures, paypalRefunds } from "../db/schema";
import { openingQuotes } from "../opening/schema";
import type { ProjectLedger } from "../approval/store";
import { changeOrders, pricingCases } from "../pricing/schema";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import { cancelCheckout, completeAuthorization, createCheckout, type CheckoutDetails, type CheckoutLinks } from "./authorize";
import type { FundingPlan } from "../approval/funding";
import { businessItem, confirmedPlan, lockConfirmedVersion, PaymentActionError, type LineRef, type ShownVersion, type Tx } from "./binding";
import { lockOpeningVersion, openingPlan } from "./opening";
import { executeCapture, refreshCapture } from "./capture";
import { insertOperation, type OperationBinding, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { executeRefund, refreshRefund } from "./refund";
import { executeSavedHold } from "./saved-hold";
import { executeVoid } from "./void";

export type { LineRef } from "./binding";

/** Builds the PayPal return and cancel links for an operation. */
export type LinkBuilder = (operationId: string) => CheckoutLinks;

/** What the buyer sees on PayPal for an authorization, and what saving PayPal for the project means. */
export async function checkoutDetails(db: Pick<Db, "select">, operation: PaymentOperation): Promise<CheckoutDetails> {
  const [{ projectName, version }] = operation.changeOrderId
    ? (await db.select({ document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId))).map(({ document }) => document)
    : (await db.select({ document: openingQuotes.document }).from(openingQuotes).innerJoin(pricingCases, eq(pricingCases.caseId, openingQuotes.caseId))
      .where(eq(pricingCases.baselineRevisionId, operation.revisionId!))).map(({ document }) => ({ projectName: document.projectName, version: 1 }));
  const [item] = operation.itemId ? await db.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId)) : [{ name: "Design services" }];
  return {
    description: `${projectName} · ${item.name} · V${version} (Setti sandbox demo)`,
    ...(operation.savePaymentMethod ? { savePayPalDescription: `Setti · ${projectName}: holds for the items you approve (sandbox demo)` } : {}),
  };
}

/**
 * Client step: hold the confirmed amount a furniture line still needs. Returns
 * the operation; while it waits for the buyer, its approval link leads to PayPal.
 */
export async function startAuthorization(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, input: LineRef & ShownVersion, links: LinkBuilder): Promise<PaymentOperation> {
  const operation = await db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const { ledger, plan: funding } = await confirmedPlan(tx, version);
    const open = ledger.operations.find((entry) => entry.kind === "authorize" && entry.itemId === itemId && (entry.status === "pending" || entry.status === "unknown"));
    if (open) {
      if (open.changeOrderId === version.order.id) return open;
      throw new PaymentActionError("PLAN_BLOCKED", "An earlier PayPal checkout for this item is still open. Finish or cancel it before starting another.");
    }
    if (funding.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before starting a payment step.", funding.blockers);
    const action = funding.actions.find((entry) => entry.kind === "new_authorization" && entry.itemId === input.itemId && entry.side === input.side);
    const line = funding.lines.find((entry) => entry.itemId === input.itemId && entry.side === input.side);
    if (!action || line?.category !== "furniture") throw new PaymentActionError("NOT_AVAILABLE", `This line needs no new authorization under V${version.order.version}.`);
    const prefix = `authorize:${version.order.id}:${itemId}:`;
    return insertOperation(tx, { businessKey: `${prefix}${attempt(ledger, "authorize", prefix)}`, projectId: version.projectId, kind: "authorize", amountCents: action.amountCents, binding: version.bind(itemId) });
  });
  return createCheckout(db, paypal, operation, links(operation.id), await checkoutDetails(db, operation));
}

/** Holds of one business item that can still be captured or voided, oldest first, with what each still holds. */
function openHolds(ledger: ProjectLedger, itemId: string, now = new Date()) {
  return ledger.authorizations
    .filter((hold) => hold.itemId === itemId && (hold.status === "created" || hold.status === "partially_captured") && !(hold.expiresAt && hold.expiresAt.getTime() <= now.getTime()))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .flatMap((hold) => {
      const taken = ledger.captures.filter((capture) => capture.authorizationId === hold.id && capture.status !== "declined");
      const heldCents = hold.amountCents - taken.reduce((total, capture) => total + capture.amountCents, 0);
      return taken.some((capture) => capture.finalCapture) || heldCents <= 0 ? [] : [{ hold, heldCents }];
    });
}

/** Completed captures of one business item that still have money to refund, newest first. */
function refundableCaptures(ledger: ProjectLedger, itemId: string) {
  const holds = new Set(ledger.authorizations.filter((hold) => hold.itemId === itemId).map((hold) => hold.id));
  return ledger.captures
    .filter((capture) => capture.status === "completed" && (capture.itemId === itemId || (capture.authorizationId && holds.has(capture.authorizationId))))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .flatMap((capture) => {
      const returned = ledger.refunds.filter((refund) => refund.captureId === capture.id && refund.status !== "failed").reduce((total, refund) => total + refund.amountCents, 0);
      const refundableCents = capture.amountCents - returned;
      return refundableCents > 0 ? [{ capture, refundableCents }] : [];
    });
}

/** Runs each operation that is not finished yet, one after another; finished ones are returned as they are. */
async function runEach(operations: PaymentOperation[], run: (id: string) => Promise<PaymentOperation>): Promise<PaymentOperation[]> {
  const results: PaymentOperation[] = [];
  for (const operation of operations) results.push(operation.status === "succeeded" || operation.status === "failed" ? operation : await run(operation.id));
  return results;
}

/** The next attempt number for a money move on one record, so a failed attempt is never reused. */
export function attempt(ledger: ProjectLedger, kind: PaymentOperation["kind"], prefix: string): number {
  return 1 + ledger.operations.filter((operation) => operation.kind === kind && operation.businessKey.startsWith(prefix)).length;
}

/**
 * Designer step after the supplier confirmed the order: capture the confirmed
 * amount, one capture per hold (oldest first), each closing its hold. Repeating
 * the step resumes the same operations; a capture that already succeeded is never sent again.
 */
export async function startCapture(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, input: LineRef & ShownVersion): Promise<PaymentOperation[]> {
  const operations = await db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const { ledger, plan } = await confirmedPlan(tx, version);
    return captureOperations(tx, { ledger, plan, projectId: version.projectId, itemId: businessItem(version, input), line: input, bind: version.bind, eventOf: (event) => event.changeOrderId === version.order.id });
  });
  return runEach(operations, (id) => executeCapture(db, paypal, id));
}

/** The same designer step for an item of a V1 the client signed line by line, after the supplier confirmed it on V1. */
export async function startOpeningCapture(db: Db, paypal: PayPalPayments, sessionId: string, key: CaseKey, input: { itemId: string; contentHash: string }): Promise<PaymentOperation[]> {
  const operations = await db.transaction(async (tx) => {
    const version = await lockOpeningVersion(tx, sessionId, key, input);
    const entry = version.approved.find((candidate) => candidate.line.itemId === input.itemId);
    if (!entry) throw new PaymentActionError("NOT_FOUND", "This line is not an approved line of quote V1.");
    const { ledger, plan } = await openingPlan(tx, version);
    return captureOperations(tx, { ledger, plan, projectId: version.projectId, itemId: entry.itemId, line: { itemId: input.itemId, side: "baseline" }, bind: version.bind, eventOf: (event) => event.revisionId === version.revisionId });
  });
  return runEach(operations, (id) => executeCapture(db, paypal, id));
}

/**
 * Writes the captures of one item once the supplier confirmed it for this version: one per
 * open hold (oldest first), each closing its hold. Repeating resumes the same operations.
 */
async function captureOperations(tx: Tx, scope: {
  ledger: ProjectLedger; plan: FundingPlan; projectId: string; itemId: string; line: LineRef;
  bind: (itemId: string) => OperationBinding; eventOf: (event: ProjectLedger["supplierEvents"][number]) => boolean;
}): Promise<PaymentOperation[]> {
  const { ledger, plan, itemId, line } = scope;
  const event = ledger.supplierEvents.find((entry) => entry.kind === "order_confirmed" && entry.itemId === itemId && scope.eventOf(entry));
  const started = event ? ledger.operations.filter((operation) => operation.kind === "capture" && operation.supplierEventId === event.id) : [];
  const open = started.filter((operation) => operation.status === "pending" || operation.status === "unknown");
  if (open.length) return open;
  if (plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before capturing.", plan.blockers);
  const action = plan.actions.find((entry) => entry.kind === "capture" && entry.timing === "after_vendor_confirmation" && entry.itemId === line.itemId && entry.side === line.side);
  if (!action) {
    if (started.length) return started;
    throw new PaymentActionError("NOT_AVAILABLE", "Nothing on this line is waiting to be captured.");
  }
  if (!event) throw new PaymentActionError("NOT_AVAILABLE", "Record the supplier's order confirmation before capturing; nothing is captured without it.");
  let remaining = action.amountCents;
  const created: PaymentOperation[] = [];
  for (const { hold, heldCents } of openHolds(ledger, itemId)) {
    if (remaining <= 0) break;
    const amountCents = Math.min(heldCents, remaining);
    const prefix = `capture:${event.id}:${hold.id}:`;
    created.push(await insertOperation(tx, { businessKey: `${prefix}${attempt(ledger, "capture", prefix)}`, projectId: scope.projectId, kind: "capture", authorizationId: hold.id, amountCents, finalCapture: true, binding: scope.bind(itemId), supplierEventId: event.id }));
    remaining -= amountCents;
  }
  if (remaining > 0) throw new PaymentActionError("PLAN_BLOCKED", "The open holds on this line no longer cover the confirmed amount. Check the authorizations before capturing.");
  return created;
}

/**
 * Designer step after the client confirmed a version that no longer needs a
 * line's holds: void each open hold (PayPal cannot void part of a hold). This is
 * a release of held money, not a refund.
 */
export async function startRelease(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, input: LineRef & ShownVersion): Promise<PaymentOperation[]> {
  const operations = await db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const { ledger, plan } = await confirmedPlan(tx, version);
    const started = ledger.operations.filter((operation) => operation.kind === "void" && operation.changeOrderId === version.order.id && operation.itemId === itemId);
    const open = started.filter((operation) => operation.status === "pending" || operation.status === "unknown");
    if (open.length) return open;
    if (plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before releasing a hold.", plan.blockers);
    const action = plan.actions.find((entry) => entry.kind === "release_authorization" && entry.timing === "on_payment_execution" && entry.itemId === input.itemId && entry.side === input.side);
    if (!action) {
      if (started.length) return started;
      throw new PaymentActionError("NOT_AVAILABLE", "No unused hold on this line needs to be released.");
    }
    const created: PaymentOperation[] = [];
    for (const { hold, heldCents } of openHolds(ledger, itemId)) {
      const prefix = `void:${version.order.id}:${hold.id}:`;
      created.push(await insertOperation(tx, { businessKey: `${prefix}${attempt(ledger, "void", prefix)}`, projectId: version.projectId, kind: "void", authorizationId: hold.id, amountCents: heldCents, binding: version.bind(itemId) }));
    }
    return created;
  });
  return runEach(operations, (id) => executeVoid(db, paypal, id));
}

/**
 * Designer step: refund what the confirmed version returns to the client, from
 * the newest completed captures first. A refund that waits on a supplier credit
 * is refused until the matching credit is recorded.
 */
export async function startRefund(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, input: LineRef & ShownVersion): Promise<PaymentOperation[]> {
  const operations = await db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const { ledger, plan } = await confirmedPlan(tx, version);
    const started = ledger.operations.filter((operation) => operation.kind === "refund" && operation.changeOrderId === version.order.id && operation.itemId === itemId);
    const open = started.filter((operation) => operation.status === "pending" || operation.status === "unknown");
    if (open.length) return open;
    if (plan.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before refunding.", plan.blockers);
    const lineActions = plan.actions.filter((entry) => entry.kind === "refund" && entry.itemId === input.itemId && entry.side === input.side);
    const action = lineActions.find((entry) => entry.timing === "on_payment_execution");
    if (!action) {
      if (lineActions.some((entry) => entry.timing === "after_vendor_credit")) throw new PaymentActionError("NOT_AVAILABLE", "This refund waits for the supplier's credit. Record the credit first.");
      if (started.length) return started;
      throw new PaymentActionError("NOT_AVAILABLE", "Nothing on this line is waiting to be refunded.");
    }
    const credit = ledger.supplierEvents.find((entry) => entry.kind === "credit_confirmed" && entry.changeOrderId === version.order.id && entry.itemId === itemId);
    let remaining = action.amountCents;
    const created: PaymentOperation[] = [];
    for (const { capture, refundableCents } of refundableCaptures(ledger, itemId)) {
      if (remaining <= 0) break;
      const amountCents = Math.min(refundableCents, remaining);
      const prefix = `refund:${credit?.id ?? version.order.id}:${capture.id}:`;
      created.push(await insertOperation(tx, { businessKey: `${prefix}${attempt(ledger, "refund", prefix)}`, projectId: version.projectId, kind: "refund", captureId: capture.id, amountCents, binding: version.bind(itemId), supplierEventId: credit?.id ?? null }));
      remaining -= amountCents;
    }
    if (remaining > 0) throw new PaymentActionError("PLAN_BLOCKED", "The completed captures on this line do not cover the confirmed refund. Reconcile the captures before refunding.");
    return created;
  });
  return runEach(operations, (id) => executeRefund(db, paypal, id));
}

/** Loads an operation of the caller's project, for any version of it (its result stays bound to that version). */
async function ownedOperation(db: Db, sessionId: string, orderId: string, operationId: string): Promise<PaymentOperation> {
  return db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, null, false);
    const [operation] = await tx.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
    if (!operation || operation.projectId !== version.projectId) throw new PaymentActionError("NOT_FOUND", "This payment step does not belong to this project.");
    return operation;
  });
}

/**
 * Reconciles one operation with PayPal: an unknown or pending result is
 * checked (and retried with the same request id), never replaced by a new operation.
 */
export async function checkPayment(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, operationId: string, links: LinkBuilder): Promise<PaymentOperation> {
  const operation = await ownedOperation(db, sessionId, orderId, operationId);
  switch (operation.kind) {
    case "authorize":
      if (operation.savedMethodId) return executeSavedHold(db, paypal, operation.id, await checkoutDetails(db, operation));
      if (!operation.paypalOrderId && (operation.status === "pending" || operation.status === "unknown")) {
        return createCheckout(db, paypal, operation, links(operation.id), await checkoutDetails(db, operation));
      }
      return (await completeAuthorization(db, paypal, operation.id)).operation;
    case "capture": {
      const done = await executeCapture(db, paypal, operation.id);
      // PayPal accepted the capture earlier but reported it pending: read where its money stands now.
      const [capture] = await db.select().from(paypalCaptures).where(eq(paypalCaptures.operationId, done.id));
      if (capture?.status === "pending") await refreshCapture(db, paypal, capture.id);
      return done;
    }
    case "void":
      return executeVoid(db, paypal, operation.id);
    case "refund": {
      const done = await executeRefund(db, paypal, operation.id);
      const [refund] = await db.select().from(paypalRefunds).where(eq(paypalRefunds.operationId, done.id));
      if (refund?.status === "pending") await refreshRefund(db, paypal, refund.id);
      return done;
    }
    default:
      throw new PaymentActionError("NOT_AVAILABLE", "This payment step cannot be checked here.");
  }
}

/** The client or studio abandons an open checkout; PayPal is asked first so an approval is never lost. */
export async function cancelPayment(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, operationId: string): Promise<PaymentOperation> {
  const operation = await ownedOperation(db, sessionId, orderId, operationId);
  if (operation.kind !== "authorize" || operation.savedMethodId) throw new PaymentActionError("NOT_AVAILABLE", "Only an open PayPal checkout can be cancelled.");
  return (await cancelCheckout(db, paypal, operation.id)).operation;
}

/** The page an operation belongs to, so a returning buyer lands on it: the change order, or the quote for V1. */
export async function operationPage(db: Pick<Db, "select">, operationId: string): Promise<{ path: string; anchor: string; projectKey: CaseKey | null } | null> {
  const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  if (!operation?.revisionId) return null;
  const [found] = operation.changeOrderId
    ? await db.select({ projectKey: chatCases.projectKey }).from(changeOrders).innerJoin(chatCases, eq(chatCases.id, changeOrders.caseId)).where(eq(changeOrders.id, operation.changeOrderId))
    : await db.select({ projectKey: chatCases.projectKey }).from(pricingCases).innerJoin(chatCases, eq(chatCases.id, pricingCases.caseId)).where(eq(pricingCases.baselineRevisionId, operation.revisionId));
  if (!found) return null;
  const anchor = operation.servicesHold ? "design-services" : "payments";
  return operation.changeOrderId ? { path: `/change-orders/${operation.changeOrderId}`, anchor, projectKey: found.projectKey } : { path: `/quotes/${found.projectKey}`, anchor, projectKey: found.projectKey };
}

/**
 * The buyer's browser came back from PayPal. It proves nothing by itself: the
 * token must name the operation's order, and the outcome is read from PayPal.
 */
export async function returnFromPayPal(db: Db, paypal: PayPalPayments, operationId: string, token: string | null, outcome: "return" | "cancel") {
  const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  if (!operation || operation.kind !== "authorize" || operation.savedMethodId || !operation.paypalOrderId || operation.paypalOrderId !== token) return null;
  const result = outcome === "return" ? await completeAuthorization(db, paypal, operation.id) : await cancelCheckout(db, paypal, operation.id);
  return { orderId: operation.changeOrderId, servicesHold: operation.servicesHold, state: result.state };
}
