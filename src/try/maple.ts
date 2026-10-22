/**
 * The Maple starting state that /try seeds for each visitor and the Sandbox proof
 * starts from: Emma confirmed V2 with in-stock versions of the lounge chair and
 * the wool rug, the chair is held on PayPal, and the rug is captured after its
 * supplier confirmed the order. It drives the app's own chat, pricing, approval
 * and payment code. Only the AI draft is scripted, and supplier events are
 * designer-entered demo records, exactly as in the app.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations } from "../db/schema";
import { returnFromPayPal, startAuthorization, startCapture, type LinkBuilder } from "../payments/actions";
import type { PaymentOperation } from "../payments/operations";
import type { PayPalPayments } from "../payments/paypal";
import { recordSupplierOrder } from "../payments/supplier";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";
import { confirmScriptedChanges, shown, type ScriptedCopy } from "./scripted-change";

export const MAPLE = "maple" as const;

export interface PaymentStep {
  label: string;
  operations: Pick<PaymentOperation, "id" | "kind" | "status" | "amountCents" | "attempts" | "paypalOrderId" | "paypalResourceId">[];
}

export interface MapleOptions {
  db: Db;
  paypal: PayPalPayments;
  links: LinkBuilder;
  /** Approves this PayPal order (the buyer on PayPal, or the Sandbox test card); resolves once PayPal reports it approved. */
  approve: (approvalUrl: string, paypalOrderId: string, label: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Runs the money steps of one session and records each as it ends. */
export interface MapleRun {
  session: string;
  steps: PaymentStep[];
  record: (label: string, operations: PaymentOperation[]) => PaymentOperation[];
  log: (message: string) => void;
}

const startCopy: Partial<ScriptedCopy> = {
  request: "Jordan found in-stock versions of the lounge chair and the wool rug at the same prices. Please update the quote with them.",
  reply: "I drafted V2: the lounge chair and the wool rug switch to the in-stock versions at the same prices. Jordan checks the supplier terms before you confirm.",
  title: "In-stock lounge chair and wool rug",
  model: "scripted draft",
  terms: "Emma confirms V2. Each item is held on PayPal and charged only after its supplier confirms the order.",
  reviewNotes: "Checked the in-stock prices and return terms with the supplier.",
  priceEvidence: "Supplier price list (demo).",
  oldItemNote: "The V1 item was never ordered.",
  issueNote: "Checked by the designer.",
};

/** Fixed supplier terms are demo inputs, not claims about a real seller. */
export function product(name: string, sku: string, unitPriceCents: number): Partial<PricingItem> {
  return {
    name, vendor: "Demo supplier", sku, specification: name,
    quantity: 1, unitLabel: "each", currency: "USD", unitPriceCents,
    taxCents: 0, freightCents: 0, returnable: true,
    returnPolicy: "Demo terms reviewed by the designer.",
  };
}

export const ref = (itemId: string, side: "baseline" | "proposed" = "baseline") => ({ itemId, side });

export function mapleRun(session: string, log: (message: string) => void = () => {}): MapleRun {
  const steps: PaymentStep[] = [];
  const record = (label: string, operations: PaymentOperation[]) => {
    steps.push({ label, operations: operations.map(({ id, kind, status, amountCents, attempts, paypalOrderId, paypalResourceId }) => ({ id, kind, status, amountCents, attempts, paypalOrderId, paypalResourceId })) });
    log(`${label}: ${operations.map((operation) => `${operation.kind} ${operation.status}`).join(", ")}`);
    return operations;
  };
  return { session, steps, record, log };
}

/** The designer records the supplier's confirmation of a confirmed line, on its exact terms. */
export function confirmSupplierOrder(db: Db, run: MapleRun, order: FrozenChangeOrder, itemId: string) {
  const line = order.lines.find((entry) => entry.itemId === itemId)!;
  return recordSupplierOrder(db, run.session, order.id, {
    ...ref(itemId, "proposed"), ...shown(order), quantity: line.quantity,
    unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
    inStock: true, leadTimeDays: 14, reference: `DEMO-ORDER-${itemId}`, note: "Demo supplier confirmation entered by the designer.",
  });
}

/** Starts the checkout, has it approved, and finishes the authorization the way PayPal's return does. */
export async function authorizeItem(options: MapleOptions, run: MapleRun, order: FrozenChangeOrder, itemId: string, label: string) {
  const { db, paypal, links } = options;
  const checkout = await startAuthorization(db, paypal, run.session, order.id, { ...ref(itemId, "proposed"), ...shown(order) }, links);
  if (!checkout.paypalOrderId || !checkout.approvalUrl) throw new Error(`${label}: PayPal did not return an approval link (${checkout.status}).`);
  await options.approve(checkout.approvalUrl, checkout.paypalOrderId, label);
  const back = await returnFromPayPal(db, paypal, checkout.id, checkout.paypalOrderId, "return");
  if (back?.state !== "authorized") throw new Error(`${label}: authorization did not complete (${back?.state ?? "no result"}).`);
  const [authorized] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, checkout.id));
  run.record(label, [authorized]);
}

/** Confirms V2, holds the chair, and captures the rug after its supplier confirmed it. */
export async function startMaple(options: MapleOptions, run: MapleRun): Promise<FrozenChangeOrder> {
  const { db, paypal } = options;
  run.log("Confirming the first version: a lounge chair and a wool rug.");
  const initial = await confirmScriptedChanges(db, run.session, MAPLE, [
    { action: "replace", itemId: "chair", after: product("Lounge chair", "DEMO-CHAIR-2", 80_000) },
    { action: "replace", itemId: "rug", after: product("Wool rug", "DEMO-RUG-2", 30_000) },
  ], { copy: startCopy });
  await authorizeItem(options, run, initial, "chair", "Authorize the lounge chair ($800.00)");
  await authorizeItem(options, run, initial, "rug", "Authorize the wool rug ($300.00)");
  await confirmSupplierOrder(db, run, initial, "rug");
  run.record("Capture the rug after supplier confirmation", await startCapture(db, paypal, run.session, initial.id, { ...ref("rug", "proposed"), ...shown(initial) }));
  return initial;
}
