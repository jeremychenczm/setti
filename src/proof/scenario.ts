/**
 * The Sandbox proof scenario: one confirmed change moves three items that are in
 * different money states. It drives the app's own chat, pricing, approval and
 * payment code. Only the AI draft is a fixed draft, and supplier events are
 * designer-entered demo records, exactly as in the app.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations } from "../db/schema";
import { checkPayment, returnFromPayPal, startAuthorization, startCapture, startRefund, startRelease, type LinkBuilder } from "../payments/actions";
import type { PaymentOperation } from "../payments/operations";
import type { PayPalPayments, PayPalResult, RefundCommand, RefundReceipt } from "../payments/paypal";
import { recordSupplierCredit, recordSupplierOrder } from "../payments/supplier";
import { confirmChanges, shown } from "../payments/testing/cases";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";

export const PROOF_CASE = "maple" as const;

export interface ProofStep {
  label: string;
  operations: Pick<PaymentOperation, "id" | "kind" | "status" | "amountCents" | "attempts" | "paypalOrderId" | "paypalResourceId">[];
}

export interface ProofRun {
  session: string;
  projectId: string;
  initial: FrozenChangeOrder;
  mixed: FrozenChangeOrder;
  steps: ProofStep[];
  /** The refund operation whose first PayPal answer was discarded, if the drill ran. */
  droppedRefundOperationId: string | null;
}

export interface ProofOptions {
  db: Db;
  paypal: PayPalPayments;
  links: LinkBuilder;
  /** The buyer approves this PayPal order; resolves once PayPal reports it approved. */
  approve: (approvalUrl: string, paypalOrderId: string, label: string) => Promise<void>;
  /** Discard the first refund answer after PayPal has processed it, then recover it. */
  dropRefundResponse?: boolean;
  log?: (message: string) => void;
}

/** Fixed supplier terms are proof inputs, not claims about a real seller. */
function product(name: string, sku: string, unitPriceCents: number): Partial<PricingItem> {
  return {
    name, vendor: "Demo supplier", sku, specification: name,
    quantity: 1, unitLabel: "each", currency: "USD", unitPriceCents,
    taxCents: 0, freightCents: 0, returnable: true,
    returnPolicy: "Demo terms reviewed by the designer.",
  };
}

/** A PayPal client that loses the first refund answer after PayPal has processed it. */
export function losingFirstRefundAnswer(paypal: PayPalPayments, onDrop: (command: RefundCommand) => void): PayPalPayments {
  let dropped = false;
  const refundCapture = async (command: RefundCommand): Promise<PayPalResult<RefundReceipt>> => {
    const result = await paypal.refundCapture(command);
    if (dropped || result.kind !== "ok") return result;
    dropped = true;
    onDrop(command);
    return { kind: "unknown", message: "The proof runner discarded this answer after PayPal processed the refund." };
  };
  return new Proxy(paypal, {
    get(target, property, receiver) {
      if (property === "refundCapture") return refundCapture;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runMixedChangeProof(options: ProofOptions): Promise<ProofRun> {
  const { db, paypal, links } = options;
  const log = options.log ?? (() => {});
  const session = randomUUID();
  const steps: ProofStep[] = [];
  const ref = (itemId: string, side: "baseline" | "proposed" = "baseline") => ({ itemId, side });
  const record = (label: string, operations: PaymentOperation[]) => {
    steps.push({ label, operations: operations.map(({ id, kind, status, amountCents, attempts, paypalOrderId, paypalResourceId }) => ({ id, kind, status, amountCents, attempts, paypalOrderId, paypalResourceId })) });
    log(`${label}: ${operations.map((operation) => `${operation.kind} ${operation.status}`).join(", ")}`);
    return operations;
  };
  const supplier = (order: FrozenChangeOrder, itemId: string) => {
    const line = order.lines.find((entry) => entry.itemId === itemId)!;
    return recordSupplierOrder(db, session, order.id, {
      ...ref(itemId, "proposed"), ...shown(order), quantity: line.quantity,
      unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
      inStock: true, leadTimeDays: 14, reference: `DEMO-ORDER-${itemId}`, note: "Demo supplier confirmation entered by the designer.",
    });
  };
  async function authorize(order: FrozenChangeOrder, itemId: string, label: string) {
    const checkout = await startAuthorization(db, paypal, session, order.id, { ...ref(itemId, "proposed"), ...shown(order) }, links);
    if (!checkout.paypalOrderId || !checkout.approvalUrl) throw new Error(`${label}: PayPal did not return an approval link (${checkout.status}).`);
    await options.approve(checkout.approvalUrl, checkout.paypalOrderId, label);
    const back = await returnFromPayPal(db, paypal, checkout.id, checkout.paypalOrderId, "return");
    if (back?.state !== "authorized") throw new Error(`${label}: authorization did not complete (${back?.state ?? "no result"}).`);
    const [authorized] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, checkout.id));
    record(label, [authorized]);
  }

  log("Confirming the first version: a lounge chair and a wool rug.");
  const initial = await confirmChanges(db, session, PROOF_CASE, [
    { action: "replace", itemId: "chair", after: product("Lounge chair", "DEMO-CHAIR-2", 80_000) },
    { action: "replace", itemId: "rug", after: product("Wool rug", "DEMO-RUG-2", 30_000) },
  ]);
  await authorize(initial, "chair", "Authorize the lounge chair ($800.00)");
  await authorize(initial, "rug", "Authorize the wool rug ($300.00)");
  await supplier(initial, "rug");
  record("Capture the rug after supplier confirmation", await startCapture(db, paypal, session, initial.id, { ...ref("rug", "proposed"), ...shown(initial) }));

  log("Confirming one change: the chair becomes a writing desk and the rug is returned with a $60 restocking fee.");
  const mixed = await confirmChanges(db, session, PROOF_CASE, [
    { action: "replace", itemId: "chair", after: product("Oak writing desk", "DEMO-DESK-1", 110_000), oldItemHandling: "not_ordered", oldItemCostCents: 0 },
    { action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000 },
  ]);
  record("Release the lounge chair hold", await startRelease(db, paypal, session, mixed.id, { ...ref("chair"), ...shown(mixed) }));
  await authorize(mixed, "chair", "Authorize the writing desk ($1,100.00)");
  await supplier(mixed, "chair");
  record("Capture the desk after supplier confirmation", await startCapture(db, paypal, session, mixed.id, { ...ref("chair", "proposed"), ...shown(mixed) }));
  await recordSupplierCredit(db, session, mixed.id, { ...ref("rug"), ...shown(mixed), creditCents: 24_000, reference: "DEMO-RUG-CREDIT", note: "Demo return credit, net of the confirmed $60 restocking fee." });

  let droppedRefundOperationId: string | null = null;
  const refundPayPal = options.dropRefundResponse
    ? losingFirstRefundAnswer(paypal, (command) => { droppedRefundOperationId = command.customId; log("Drill: PayPal processed the refund; its answer is discarded."); })
    : paypal;
  const refunds = record("Refund the rug minus the restocking fee", await startRefund(db, refundPayPal, session, mixed.id, { ...ref("rug"), ...shown(mixed) }));
  for (const operation of refunds.filter((entry) => entry.status === "unknown")) {
    record("Check the refund whose answer was lost", [await checkPayment(db, paypal, session, mixed.id, operation.id, links)]);
  }

  // A later record of the same operation (the recovery check) supersedes an earlier one.
  const latest = new Map(steps.flatMap((step) => step.operations).map((operation) => [operation.id, operation]));
  const unfinished = [...latest.values()].filter((operation) => operation.status !== "succeeded");
  if (unfinished.length) throw new Error(`Some payment steps did not succeed: ${unfinished.map((operation) => `${operation.kind} ${operation.status}`).join(", ")}`);
  const [row] = await db.select({ projectId: paymentOperations.projectId }).from(paymentOperations).where(eq(paymentOperations.id, steps[0].operations[0].id));
  return { session, projectId: row.projectId, initial, mixed, steps, droppedRefundOperationId };
}
