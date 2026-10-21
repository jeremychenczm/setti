/**
 * Business entry points for payment steps. Each one goes through the common
 * entry (`lockConfirmedVersion`), takes its amount from the funding plan of
 * recorded facts (never from the request), and writes one operation per
 * business event, so a repeated click or a second window resumes the same
 * operation. PayPal is called only after the case lock is released.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { items, paymentOperations } from "../db/schema";
import { buildFundingPlan } from "../approval/funding";
import { fundingFactsFrom, fundingIdentities, readLedger } from "../approval/store";
import { changeOrders } from "../pricing/schema";
import { cancelCheckout, completeAuthorization, createCheckout, type CheckoutLinks } from "./authorize";
import { lockConfirmedVersion, PaymentActionError, type ConfirmedVersion, type ShownVersion, type Tx } from "./binding";
import { executeCapture } from "./capture";
import { insertOperation, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { executeVoid } from "./void";

export interface LineRef {
  itemId: string;
  side: "baseline" | "proposed";
}

/** Builds the PayPal return and cancel links for an operation. */
export type LinkBuilder = (operationId: string) => CheckoutLinks;

function businessItem(version: ConfirmedVersion, line: LineRef): string {
  const id = fundingIdentities(version.order, version.itemMapping).byGroup.get(`${line.side}:${line.itemId}`);
  if (!id) throw new PaymentActionError("NOT_FOUND", "This line has no business item in the confirmed version.");
  return id;
}

async function plan(tx: Tx, version: ConfirmedVersion) {
  const ledger = await readLedger(tx, version.projectId);
  return { ledger, plan: buildFundingPlan(version.order, fundingFactsFrom(version.order, version.itemMapping, ledger)) };
}

/** What the buyer sees on PayPal for an authorization. */
async function checkoutDescription(db: Pick<Db, "select">, operation: PaymentOperation): Promise<string> {
  const [order] = await db.select({ document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.id, operation.changeOrderId!));
  const [item] = await db.select({ name: items.name }).from(items).where(eq(items.id, operation.itemId!));
  return `${order.document.projectName} · ${item.name} · V${order.document.version} (Setti sandbox demo)`;
}

/**
 * Client step: hold the confirmed amount a furniture line still needs. Returns
 * the operation; while it waits for the buyer, its approval link leads to PayPal.
 */
export async function startAuthorization(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, input: LineRef & ShownVersion, links: LinkBuilder): Promise<PaymentOperation> {
  const operation = await db.transaction(async (tx) => {
    const version = await lockConfirmedVersion(tx, sessionId, orderId, input);
    const itemId = businessItem(version, input);
    const { ledger, plan: funding } = await plan(tx, version);
    const open = ledger.operations.find((entry) => entry.kind === "authorize" && entry.itemId === itemId && (entry.status === "pending" || entry.status === "unknown"));
    if (open) {
      if (open.changeOrderId === version.order.id) return open;
      throw new PaymentActionError("PLAN_BLOCKED", "An earlier PayPal checkout for this item is still open. Finish or cancel it before starting another.");
    }
    if (funding.status === "blocked") throw new PaymentActionError("PLAN_BLOCKED", "Resolve the funding blockers before starting a payment step.", funding.blockers);
    const action = funding.actions.find((entry) => entry.kind === "new_authorization" && entry.itemId === input.itemId && entry.side === input.side);
    const line = funding.lines.find((entry) => entry.itemId === input.itemId && entry.side === input.side);
    if (!action || line?.category !== "furniture") throw new PaymentActionError("NOT_AVAILABLE", `This line needs no new authorization under V${version.order.version}.`);
    const attempt = 1 + ledger.operations.filter((entry) => entry.kind === "authorize" && entry.changeOrderId === version.order.id && entry.itemId === itemId).length;
    return insertOperation(tx, { businessKey: `authorize:${version.order.id}:${itemId}:${attempt}`, projectId: version.projectId, kind: "authorize", amountCents: action.amountCents, binding: version.bind(itemId) });
  });
  return createCheckout(db, paypal, operation, links(operation.id), { description: await checkoutDescription(db, operation) });
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
      if (!operation.paypalOrderId && (operation.status === "pending" || operation.status === "unknown")) {
        return createCheckout(db, paypal, operation, links(operation.id), { description: await checkoutDescription(db, operation) });
      }
      return (await completeAuthorization(db, paypal, operation.id)).operation;
    case "capture":
      return executeCapture(db, paypal, operation.id);
    case "void":
      return executeVoid(db, paypal, operation.id);
    default:
      throw new PaymentActionError("NOT_AVAILABLE", "This payment step cannot be checked here yet.");
  }
}

/** The client or studio abandons an open checkout; PayPal is asked first so an approval is never lost. */
export async function cancelPayment(db: Db, paypal: PayPalPayments, sessionId: string, orderId: string, operationId: string): Promise<PaymentOperation> {
  const operation = await ownedOperation(db, sessionId, orderId, operationId);
  if (operation.kind !== "authorize") throw new PaymentActionError("NOT_AVAILABLE", "Only an open PayPal checkout can be cancelled.");
  return (await cancelCheckout(db, paypal, operation.id)).operation;
}

/** The change order an operation was started for, so a returning buyer lands on the right page. */
export async function operationChangeOrder(db: Pick<Db, "select">, operationId: string): Promise<string | null> {
  const [operation] = await db.select({ changeOrderId: paymentOperations.changeOrderId }).from(paymentOperations).where(eq(paymentOperations.id, operationId));
  return operation?.changeOrderId ?? null;
}

/**
 * The buyer's browser came back from PayPal. It proves nothing by itself: the
 * token must name the operation's order, and the outcome is read from PayPal.
 */
export async function returnFromPayPal(db: Db, paypal: PayPalPayments, operationId: string, token: string | null, outcome: "return" | "cancel") {
  const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  if (!operation || operation.kind !== "authorize" || !operation.paypalOrderId || operation.paypalOrderId !== token) return null;
  const result = outcome === "return" ? await completeAuthorization(db, paypal, operation.id) : await cancelCheckout(db, paypal, operation.id);
  return { orderId: operation.changeOrderId!, state: result.state };
}
