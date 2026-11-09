/**
 * The Sandbox proof scenario: one confirmed change moves three items that are in
 * different money states. It starts from the same Maple state /try seeds, then
 * drives the app's own chat, pricing, approval and payment code. Only the AI
 * draft is a fixed draft, and supplier events are designer-entered demo records,
 * exactly as in the app.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { paymentOperations } from "../db/schema";
import { checkPayment, startCapture, startRefund, startRelease } from "../payments/actions";
import type { PayPalPayments, PayPalResult, RefundCommand, RefundReceipt } from "../payments/paypal";
import { recordSupplierCredit } from "../payments/supplier";
import { confirmChanges, shown } from "../payments/testing/cases";
import type { FrozenChangeOrder } from "../pricing/types";
import { authorizeItem, confirmSupplierOrder, MAPLE, mapleRun, product, ref, startMaple, type MapleOptions, type PaymentStep } from "../try/maple";

export const PROOF_CASE = MAPLE;

export type ProofStep = PaymentStep;

export interface ProofRun {
  session: string;
  projectId: string;
  initial: FrozenChangeOrder;
  mixed: FrozenChangeOrder;
  steps: ProofStep[];
  /** The refund operation whose first PayPal answer was discarded, if the drill ran. */
  droppedRefundOperationId: string | null;
}

export interface ProofOptions extends MapleOptions {
  /** Discard the first refund answer after PayPal has processed it, then recover it. */
  dropRefundResponse?: boolean;
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
  const run = mapleRun(randomUUID(), options.log);
  const { session, steps, record, log } = run;
  const initial = await startMaple(options, run);

  log("Confirming one change: the chair becomes a writing desk and the rug is returned with a $60 restocking fee.");
  const mixed = await confirmChanges(db, session, PROOF_CASE, [
    { action: "replace", itemId: "chair", after: product("Oak writing desk", "DEMO-DESK-1", 110_000), oldItemHandling: "not_ordered", oldItemCostCents: 0 },
    { action: "remove", itemId: "rug", oldItemHandling: "returned", oldItemCostCents: 6_000, oldItemFees: [{ kind: "restocking_fee", amountCents: 6_000 }] },
  ]);
  record("Release the lounge chair hold", await startRelease(db, paypal, session, mixed.id, { ...ref("chair"), ...shown(mixed) }));
  await authorizeItem(options, run, mixed, "chair", "Authorize the writing desk ($1,100.00)");
  await confirmSupplierOrder(db, run, mixed, "chair");
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
