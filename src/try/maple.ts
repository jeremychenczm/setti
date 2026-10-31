/**
 * The Maple starting state that /try seeds for each visitor and the Sandbox proof
 * starts from: Emma confirmed V2 with in-stock versions of the lounge chair and
 * the wool rug, the chair is held on PayPal, and the rug is captured after its
 * supplier confirmed the order. It drives the app's own chat, pricing, approval
 * and payment code. Only the AI draft is scripted, and supplier events are
 * designer-entered demo records, exactly as in the app.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { paymentOperations, paypalCaptures, revisions } from "../db/schema";
import { createApprovalStore } from "../approval/store";
import { chatCases } from "../chat/schema";
import { clientSignatureName } from "../opening/types";
import { changeOrders } from "../pricing/schema";
import { checkoutDetails, returnFromPayPal, startAuthorization, startCapture, type LinkBuilder } from "../payments/actions";
import { completeAuthorization, createCheckout } from "../payments/authorize";
import { businessItem, lockConfirmedVersion } from "../payments/binding";
import { executeCapture, refreshCapture } from "../payments/capture";
import type { PaymentOperation } from "../payments/operations";
import type { PayPalPayments } from "../payments/paypal";
import { recordSupplierOrder } from "../payments/supplier";
import type { FrozenChangeOrder, PricingItem } from "../pricing/types";
import { confirmScriptedChanges, shown, type ScriptedCopy } from "./scripted-change";

export const MAPLE = "maple" as const;

export class MaplePreparationError extends Error {
  constructor(message: string, readonly recoverable = true) { super(message); }
}

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
export function confirmSupplierOrder(db: Db, run: MapleRun, order: FrozenChangeOrder, itemId: string, side: "baseline" | "proposed" = "proposed") {
  const line = order.lines.find((entry) => entry.itemId === itemId)!;
  return recordSupplierOrder(db, run.session, order.id, {
    ...ref(itemId, side), ...shown(order), quantity: line.quantity,
    unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents,
    inStock: true, leadTimeDays: 14, reference: `DEMO-ORDER-${itemId}`, note: "Demo supplier confirmation entered by the designer.",
  });
}

/** Starts the checkout, has it approved, and finishes the authorization the way PayPal's return does. */
export async function authorizeItem(options: MapleOptions, run: MapleRun, order: FrozenChangeOrder, itemId: string, label: string, side: "baseline" | "proposed" = "proposed") {
  const { db, paypal, links } = options;
  const prior = await originalOperation(db, run, order, itemId, "authorize", side);
  if (prior?.status === "succeeded") { run.record(label, [prior]); return prior; }
  if (prior?.status === "failed") throw new MaplePreparationError(`${label}: PayPal refused this original authorization. It needs review before another hold is attempted.`, false);
  let checkout = prior
    ? await createCheckout(db, paypal, prior, links(prior.id), await checkoutDetails(db, prior))
    : await startAuthorization(db, paypal, run.session, order.id, { ...ref(itemId, side), ...shown(order) }, links);
  if (checkout.status === "failed") throw new MaplePreparationError(`${label}: PayPal refused the original checkout.`, false);
  if (checkout.paypalOrderId && !checkout.approvalUrl) checkout = (await completeAuthorization(db, paypal, checkout.id)).operation;
  if (checkout.status === "succeeded") { run.record(label, [checkout]); return checkout; }
  if (!checkout.paypalOrderId || !checkout.approvalUrl) throw new MaplePreparationError(`${label}: PayPal did not return an approval link (${checkout.status}).`, checkout.status !== "failed");
  const found = await paypal.getOrder(checkout.paypalOrderId);
  if (found.kind !== "ok") throw new MaplePreparationError(`${label}: the original PayPal order could not be read; no replacement was created.`);
  if (found.value.status !== "APPROVED" && found.value.status !== "COMPLETED") await options.approve(checkout.approvalUrl, checkout.paypalOrderId, label);
  const back = await returnFromPayPal(db, paypal, checkout.id, checkout.paypalOrderId, "return");
  const [authorized] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, checkout.id));
  if (back?.state !== "authorized") throw new MaplePreparationError(`${label}: authorization did not complete (${back?.state ?? "no result"}).`, authorized.status !== "failed");
  run.record(label, [authorized]);
  return authorized;
}

/** Reuses V2 even if preparing it finished just before the previous request stopped. */
export async function ensureMapleQuote(db: Db, session: string): Promise<FrozenChangeOrder> {
  const [existing] = await db.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
    .innerJoin(chatCases, eq(chatCases.id, changeOrders.caseId)).innerJoin(revisions, eq(revisions.id, changeOrders.revisionId))
    .where(and(eq(chatCases.sessionId, session), eq(chatCases.projectKey, MAPLE), eq(revisions.number, 2)));
  if (existing) {
    const order = existing.document;
    const chair = order.lines.find((line) => line.itemId === "chair"), rug = order.lines.find((line) => line.itemId === "rug");
    if (chair?.sku !== "DEMO-CHAIR-2" || chair.unitPriceCents !== 80_000 || rug?.sku !== "DEMO-RUG-2" || rug.unitPriceCents !== 30_000) {
      throw new MaplePreparationError("This project's V2 is different from the prepared Maple scenario. Its existing money was left unchanged.", false);
    }
    if (existing.status !== "sent" && existing.status !== "approved") throw new MaplePreparationError("The prepared V2 has been replaced or declined. Continue the existing project instead of preparing more money.", false);
    if (existing.status === "sent") await createApprovalStore(db).decide(session, order.id, {
      decision: "approved", ...shown(order), acknowledged: true, signature: clientSignatureName(order), note: "",
    });
    return order;
  }
  return confirmScriptedChanges(db, session, MAPLE, [
    { action: "replace", itemId: "chair", after: product("Lounge chair", "DEMO-CHAIR-2", 80_000) },
    { action: "replace", itemId: "rug", after: product("Wool rug", "DEMO-RUG-2", 30_000) },
  ], { copy: startCopy });
}

async function originalOperation(db: Db, run: MapleRun, order: FrozenChangeOrder, itemId: string, kind: "authorize" | "capture", side: "baseline" | "proposed" = "proposed") {
  const version = await db.transaction((tx) => lockConfirmedVersion(tx, run.session, order.id, shown(order)));
  const businessId = businessItem(version, ref(itemId, side));
  const [operation] = await db.select().from(paymentOperations).where(and(
    eq(paymentOperations.changeOrderId, order.id), eq(paymentOperations.itemId, businessId), eq(paymentOperations.kind, kind),
  )).orderBy(paymentOperations.createdAt).limit(1);
  return operation;
}

/** Resumes the original capture, including pending provider outcomes; never substitutes a new attempt. */
export async function captureMapleRug(options: MapleOptions, run: MapleRun, initial: FrozenChangeOrder) {
  return capturePreparedItem(options, run, initial, "rug", "rug");
}

/** The original business operation is reused for every prepared scenario item. */
export async function capturePreparedItem(options: MapleOptions, run: MapleRun, initial: FrozenChangeOrder, itemId: string, label: string, side: "baseline" | "proposed" = "proposed") {
  const prior = await originalOperation(options.db, run, initial, itemId, "capture", side);
  if (prior?.status === "failed") throw new MaplePreparationError(`The original ${label} capture was refused and needs review before another attempt.`, false);
  const operations = prior ? [await executeCapture(options.db, options.paypal, prior.id)]
    : await startCapture(options.db, options.paypal, run.session, initial.id, { ...ref(itemId, side), ...shown(initial) });
  run.record(`Capture the ${label} after supplier confirmation`, operations);
  for (const operation of operations) {
    if (operation.status !== "succeeded") throw new MaplePreparationError(`PayPal has not confirmed the original ${label} capture yet.`, operation.status !== "failed");
    const [capture] = await options.db.select().from(paypalCaptures).where(eq(paypalCaptures.operationId, operation.id));
    const current = capture?.status === "pending" ? await refreshCapture(options.db, options.paypal, capture.id) : capture;
    if (current?.status !== "completed") throw new MaplePreparationError(`The original ${label} capture is still pending or declined.`, current?.status !== "declined");
  }
  return operations;
}

/** Confirms V2, holds the chair, and captures the rug after its supplier confirmed it. */
export async function startMaple(options: MapleOptions, run: MapleRun): Promise<FrozenChangeOrder> {
  const { db } = options;
  run.log("Confirming the first version: a lounge chair and a wool rug.");
  const initial = await ensureMapleQuote(db, run.session);
  await authorizeItem(options, run, initial, "chair", "Authorize the lounge chair ($800.00)");
  await authorizeItem(options, run, initial, "rug", "Authorize the wool rug ($300.00)");
  await confirmSupplierOrder(db, run, initial, "rug");
  await captureMapleRug(options, run, initial);
  return initial;
}
