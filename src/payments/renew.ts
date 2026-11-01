/**
 * Renews holds still waiting for their supplier near the end of their 29 days:
 * a new hold of the same amount with the client's saved payment method, bound
 * to the current agreement, and only once it is in place is the old hold voided.
 * The client agreed to the saved method for this project and the amount does not
 * change, so this needs no new approval; the renewal notice gave both people two
 * days to stop it first.
 *
 * A hold is renewed when every one of these holds: the item is a furniture item
 * of the current agreement, not cancelled, not confirmed by its supplier, nothing
 * captured; the hold is at least 25 days old and not expired; its renewal notice
 * was given at least two days earlier; a payment method is saved. A failed
 * renewal leaves the old hold as it was. A void that did not go through is tried
 * again on the next run.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, paymentOperations, paypalAuthorizations, renewalNotices } from "../db/schema";
import { attempt, checkoutDetails } from "./actions";
import { NOTICE_LEAD_DAYS, RENEWAL_DAY } from "./attention";
import { PaymentActionError } from "./binding";
import { holdClock } from "./hold-clock";
import { insertOperation, type OperationBinding, type PaymentOperation } from "./operations";
import type { PayPalPayments } from "./paypal";
import { executeSavedHold } from "./saved-hold";
import { activeSavedMethod } from "./saved-methods";
import { lockPaymentBasis } from "./services";
import { executeVoid } from "./void";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RenewalOutcome {
  itemLabel: string;
  amountCents: number;
  oldAuthorizationId: string;
  newAuthorizationId: string | null;
  newExpiresAt: string | null;
  /** `renewed`: the new hold is in place and the old one released. `old_still_open`: the release is tried again next time. */
  status: "renewed" | "old_still_open" | "failed" | "unknown";
  message: string | null;
  /** The new hold was placed by this run, not by an earlier one that is only being finished now. */
  fresh: boolean;
  /** This run released the old hold. */
  released: boolean;
}

interface Planned { holdId: string; paypalAuthorizationId: string; itemLabel: string; amountCents: number; binding: OperationBinding; renewal: PaymentOperation | null; projectId: string }

/** What a saved method is called in the chat. */
export function methodName(method: { kind: "paypal" | "card"; label: string | null }): string {
  return method.kind === "card" ? `saved card${method.label ? ` (${method.label})` : ""}` : "saved PayPal";
}

export async function renewDueHolds(db: Db, paypal: PayPalPayments, scope: { sessionId: string; projectKey: CaseKey }, now: Date): Promise<RenewalOutcome[]> {
  let planned: Planned[];
  try {
    planned = await db.transaction(async (tx) => {
      const basis = await lockPaymentBasis(tx, scope.sessionId, scope.projectKey);
      const saved = await activeSavedMethod(tx, basis.projectId);
      if (!saved) return [];
      const { ledger } = basis;
      const notices = ledger.authorizations.length ? await tx.select().from(renewalNotices).where(inArray(renewalNotices.authorizationId, ledger.authorizations.map((hold) => hold.id))) : [];
      const furniture = new Set((await tx.select({ id: items.id }).from(items).where(and(eq(items.projectId, basis.projectId), eq(items.kind, "furniture")))).map((row) => row.id));
      const found: Planned[] = [];
      for (const line of basis.plan.lines) {
        const itemId = basis.businessItem(line);
        if (!itemId || !furniture.has(itemId) || line.targetCents === 0) continue;
        if (ledger.cancellations.some((entry) => entry.itemId === itemId)) continue;
        if (ledger.supplierEvents.some((event) => event.kind === "order_confirmed" && event.itemId === itemId && (basis.orderId ? event.changeOrderId === basis.orderId : event.revisionId === basis.key))) continue;
        const holds = ledger.authorizations.filter((hold) => hold.itemId === itemId);
        if (ledger.captures.some((capture) => capture.status !== "declined" && (capture.itemId === itemId || holds.some((hold) => hold.id === capture.authorizationId)))) continue;
        for (const hold of holds.filter((entry) => entry.status === "created")) {
          const renewals = ledger.operations.filter((operation) => operation.replacesAuthorizationId === hold.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          const live = renewals.find((operation) => operation.status !== "failed") ?? null;
          const entry = { holdId: hold.id, paypalAuthorizationId: hold.paypalAuthorizationId, itemLabel: line.label, amountCents: hold.amountCents, binding: basis.bind(itemId), projectId: basis.projectId };
          // An earlier renewal of this hold: resume it, or release the old hold it already replaced.
          if (live) { found.push({ ...entry, renewal: live }); continue; }
          const { authorizedAt, expiresAt } = holdClock(hold, ledger.operations);
          const notice = notices.find((record) => record.authorizationId === hold.id);
          const due = now.getTime() >= authorizedAt.getTime() + RENEWAL_DAY * DAY_MS && now.getTime() < expiresAt.getTime()
            && !!notice && now.getTime() >= notice.noticedAt.getTime() + NOTICE_LEAD_DAYS * DAY_MS;
          if (!due) continue;
          const prefix = `renew:${hold.id}:`;
          const renewal = await insertOperation(tx, {
            businessKey: `${prefix}${attempt(ledger, "authorize", prefix)}`, projectId: basis.projectId, kind: "authorize", amountCents: hold.amountCents,
            binding: entry.binding, savedMethodId: saved.id, replacesAuthorizationId: hold.id, renewedAt: now,
          });
          found.push({ ...entry, renewal });
        }
      }
      return found;
    });
  } catch (error) {
    if (error instanceof PaymentActionError) return [];
    throw error;
  }

  const outcomes: RenewalOutcome[] = [];
  for (const entry of planned) {
    const renewal = entry.renewal!;
    const done = renewal.status === "succeeded" ? renewal : await executeSavedHold(db, paypal, renewal.id, await checkoutDetails(db, renewal));
    const base = { itemLabel: entry.itemLabel, amountCents: entry.amountCents, oldAuthorizationId: entry.paypalAuthorizationId, fresh: renewal.status !== "succeeded" };
    if (done.status !== "succeeded") {
      outcomes.push({ ...base, newAuthorizationId: null, newExpiresAt: null, status: done.status === "failed" ? "failed" : "unknown", message: done.failureMessage ?? (done.status === "failed" ? "PayPal did not place the new hold." : "PayPal has not confirmed the new hold yet."), released: false });
      continue;
    }
    const [created] = await db.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.operationId, done.id));
    const release = await releaseReplaced(db, paypal, entry);
    outcomes.push({ ...base, newAuthorizationId: created?.paypalAuthorizationId ?? null, newExpiresAt: created?.expiresAt?.toISOString() ?? null,
      status: release?.status === "succeeded" || release === null ? "renewed" : "old_still_open", message: release && release.status !== "succeeded" ? release.failureMessage : null,
      released: release?.status === "succeeded" });
  }
  return outcomes;
}

/** Voids the hold a renewal replaced, unless it is already closed. Returns null when there was nothing left to release. */
async function releaseReplaced(db: Db, paypal: PayPalPayments, entry: Planned): Promise<PaymentOperation | null> {
  const operation = await db.transaction(async (tx) => {
    const [hold] = await tx.select().from(paypalAuthorizations).where(eq(paypalAuthorizations.id, entry.holdId)).for("update");
    if (!hold || hold.status !== "created") return null;
    const prefix = `renew-void:${hold.id}:`;
    const earlier = await tx.select().from(paymentOperations).where(eq(paymentOperations.authorizationId, hold.id));
    const open = earlier.find((candidate) => candidate.kind === "void" && candidate.businessKey.startsWith(prefix) && (candidate.status === "pending" || candidate.status === "unknown"));
    if (open) return open;
    const attempts = earlier.filter((candidate) => candidate.kind === "void" && candidate.businessKey.startsWith(prefix)).length;
    return insertOperation(tx, { businessKey: `${prefix}${attempts + 1}`, projectId: entry.projectId, kind: "void", authorizationId: hold.id, amountCents: hold.amountCents, binding: entry.binding });
  });
  return operation ? executeVoid(db, paypal, operation.id) : null;
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
const LISTED = 8;

/**
 * What both people read in the chat after a run renewed holds: each new hold
 * and the old one it replaced, by their PayPal ids, and that nothing was
 * charged. Renewals that did not go through are named too. Null when the run
 * changed nothing worth telling.
 */
export function renewalReport(outcomes: RenewalOutcome[], input: { client: string; designer: string; method: { kind: "paypal" | "card"; label: string | null } }): string | null {
  const client = input.client.split(" ")[0], designer = input.designer.split(" ")[0];
  const renewed = outcomes.filter((outcome) => outcome.fresh && (outcome.status === "renewed" || outcome.status === "old_still_open"));
  const finished = outcomes.filter((outcome) => !outcome.fresh && outcome.released);
  const failed = outcomes.filter((outcome) => outcome.fresh && (outcome.status === "failed" || outcome.status === "unknown"));
  const old = (outcome: RenewalOutcome) => outcome.status === "renewed" ? `old ${outcome.oldAuthorizationId} released` : `old ${outcome.oldAuthorizationId} not released yet, tried again on the next check`;
  const parts: string[] = [];
  if (renewed.length === 1) {
    const [outcome] = renewed;
    parts.push(`Setti renewed the hold for ${outcome.itemLabel} with ${client}'s ${methodName(input.method)}: a new ${usd(outcome.amountCents)} hold ${outcome.newAuthorizationId ?? ""}${outcome.newExpiresAt ? ` is in place until ${day(outcome.newExpiresAt)}` : " is in place"}, and the ${outcome.status === "renewed" ? `old hold ${outcome.oldAuthorizationId} was released` : `old hold ${outcome.oldAuthorizationId} is released on the next check`}. Nothing was charged.`);
  } else if (renewed.length > 1) {
    const total = renewed.reduce((sum, outcome) => sum + outcome.amountCents, 0);
    const lines = renewed.slice(0, LISTED).map((outcome) => `• ${outcome.itemLabel} · ${usd(outcome.amountCents)} · new ${outcome.newAuthorizationId ?? "hold"} · ${old(outcome)}`);
    const rest = renewed.slice(LISTED);
    parts.push(`Setti renewed ${renewed.length} holds with ${client}'s ${methodName(input.method)} (${usd(total)} in all). Nothing was charged; each old hold is released once its new one is in place:\n${lines.join("\n")}${rest.length ? `\n• and ${rest.length} more: ${rest.map((outcome) => outcome.itemLabel).join(", ")}` : ""}`);
  }
  for (const outcome of finished) parts.push(`Setti released the old hold ${outcome.oldAuthorizationId} for ${outcome.itemLabel}, which an earlier renewal replaced.`);
  if (failed.length) parts.push(`Setti could not renew the hold for ${failed.map((outcome) => outcome.itemLabel).join(", ")}: ${failed[0].message ?? "PayPal did not place the new hold."} ${failed.length === 1 ? "Its current hold stays" : "Their current holds stay"} as before, and ${designer} will follow up.`);
  return parts.length ? parts.join("\n\n") : null;
}
