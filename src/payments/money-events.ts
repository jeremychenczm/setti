/**
 * What happened to the client's money in one project, newest first: every
 * completed PayPal step (a charge, a hold, a release, a refund) with its PayPal
 * id and when Setti last heard from PayPal about it. Read from recorded facts.
 * `checkWithPayPal` reads the newest few back from PayPal first and records
 * what PayPal said, so the client sees a real, dated check, not a claim.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, paymentOperations, paypalAuthorizations, paypalCaptures, paypalCalls, paypalWebhookEvents } from "../db/schema";
import { pricingCases } from "../pricing/schema";
import { recordCall } from "./operations";
import type { PayPalPayments, PayPalResult } from "./paypal";
import type { PayPalStep } from "./schema";

export interface MoneyEvent {
  /** The operation the event comes from. */
  id: string;
  kind: "charged" | "held" | "released" | "refunded";
  itemLabel: string;
  amountCents: number;
  /** When PayPal completed the step. */
  at: string;
  /** The PayPal id of what the step produced or acted on. */
  paypalId: string | null;
  /** The last time PayPal confirmed this record: a verified webhook, Setti reading it back, or PayPal's response to the step. */
  checked: { at: string; via: "webhook" | "readback" | "response"; status: string | null } | null;
}

const READ_STEPS: PayPalStep[] = ["get_authorization", "get_capture", "get_refund"];
const RECHECK_MS = 10 * 60 * 1000;

/** The project behind a session's case, if it has one. */
async function projectOf(db: Pick<Db, "select">, sessionId: string, key: CaseKey): Promise<string | null> {
  const [row] = await db.select({ projectId: pricingCases.projectId }).from(chatCases).innerJoin(pricingCases, eq(pricingCases.caseId, chatCases.id))
    .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  return row?.projectId ?? null;
}

/**
 * The last time PayPal confirmed an operation's result. `calls` are its successful
 * PayPal calls and `pushed` its verified webhooks, both newest first.
 */
export function lastConfirmation(
  operationId: string,
  calls: readonly { operationId: string; step: string; resourceStatus: string | null; createdAt: Date }[],
  pushed: readonly { operationId: string | null; resourceStatus: string | null; receivedAt: Date }[],
): MoneyEvent["checked"] {
  const last = calls.find((call) => call.operationId === operationId);
  const event = pushed.find((entry) => entry.operationId === operationId);
  // PayPal telling Setti itself, through a verified webhook, is the strongest confirmation.
  return event ? { at: event.receivedAt.toISOString(), via: "webhook", status: event.resourceStatus }
    : last ? { at: last.createdAt.toISOString(), via: READ_STEPS.includes(last.step as PayPalStep) ? "readback" : "response", status: last.resourceStatus } : null;
}

export async function moneyEvents(db: Pick<Db, "select">, sessionId: string | null, key: CaseKey): Promise<MoneyEvent[]> {
  if (!sessionId) return [];
  const projectId = await projectOf(db, sessionId, key);
  if (!projectId) return [];
  const operations = await db.select().from(paymentOperations).where(and(eq(paymentOperations.projectId, projectId), eq(paymentOperations.status, "succeeded")));
  if (!operations.length) return [];
  const names = new Map((await db.select({ id: items.id, name: items.name }).from(items).where(eq(items.projectId, projectId))).map((row) => [row.id, row.name]));
  const holds = new Map((await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.projectId, projectId))).map((row) => [row.id, row]));
  const captures = await db.select().from(paypalCaptures).where(eq(paypalCaptures.projectId, projectId));
  const calls = await db.select().from(paypalCalls).where(and(inArray(paypalCalls.operationId, operations.map((operation) => operation.id)), eq(paypalCalls.outcome, "ok"))).orderBy(desc(paypalCalls.createdAt));
  const pushed = await db.select().from(paypalWebhookEvents).where(inArray(paypalWebhookEvents.operationId, operations.map((operation) => operation.id))).orderBy(desc(paypalWebhookEvents.receivedAt));
  const label = (itemId: string | null) => itemId ? names.get(itemId) ?? "An item" : "Design services";

  return operations.flatMap((operation): MoneyEvent[] => {
    const checked = lastConfirmation(operation.id, calls, pushed);
    const base = { id: operation.id, amountCents: operation.amountCents, at: operation.updatedAt.toISOString(), checked };
    switch (operation.kind) {
      case "authorize":
        // The design-services hold is charged at once; the charges are the client's events.
        return operation.servicesHold ? [] : [{ ...base, kind: "held", itemLabel: label(operation.itemId), paypalId: operation.paypalResourceId }];
      case "capture": {
        const capture = captures.find((entry) => entry.operationId === operation.id);
        return [{ ...base, kind: "charged", itemLabel: label(capture?.itemId ?? operation.itemId), paypalId: operation.paypalResourceId }];
      }
      case "void":
        return [{ ...base, kind: "released", itemLabel: label(operation.itemId), paypalId: operation.authorizationId ? holds.get(operation.authorizationId)?.paypalAuthorizationId ?? null : null }];
      case "refund":
        return [{ ...base, kind: "refunded", itemLabel: label(operation.itemId), paypalId: operation.paypalResourceId }];
      default:
        return [];
    }
  }).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Reads the newest events back from PayPal (at most `limit`, skipping ones read
 * in the last ten minutes) and records each answer as evidence of its step.
 * A read that fails is recorded too; the event then keeps its earlier check.
 */
export async function checkWithPayPal(db: Db, paypal: PayPalPayments, events: MoneyEvent[], limit = 8): Promise<void> {
  const due = events.filter((event) => event.paypalId && (!event.checked || event.checked.via === "response" || Date.now() - Date.parse(event.checked.at) > RECHECK_MS)).slice(0, limit);
  await Promise.all(due.map(async (event) => {
    const id = event.paypalId!;
    const [step, result]: [PayPalStep, PayPalResult<{ status?: string; amountCents?: number; currency?: string }>] =
      event.kind === "charged" ? ["get_capture", await paypal.getCapture(id)]
        : event.kind === "refunded" ? ["get_refund", await paypal.getRefund(id)]
          : ["get_authorization", await paypal.getAuthorization(id)];
    const receipt = result.kind === "ok" ? result.value : undefined;
    await recordCall(db, event.id, step, null, result, receipt && { resourceId: id, status: receipt.status, amountCents: receipt.amountCents, currency: receipt.currency });
  }));
}
