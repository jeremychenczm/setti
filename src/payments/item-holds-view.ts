/**
 * What the item-holds section shows: every approved furniture item of the
 * current agreement, what PayPal holds or captured for it, and whether the
 * project's saved PayPal can hold the rest. Read from recorded facts only.
 */
import { eq } from "drizzle-orm";
import type { DemoAccount } from "../accounts/demo";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { items, savedPaymentMethods } from "../db/schema";
import { PaymentActionError } from "./binding";
import { lockPaymentBasis } from "./services";

export interface ItemHoldView {
  /** The quote line id. */
  itemId: string;
  label: string;
  targetCents: number;
  heldCents: number;
  capturedCents: number;
  state: "captured" | "held" | "holding" | "failed" | "to_hold";
  paypalAuthorizationId: string | null;
  expiresAt: string | null;
  failureMessage: string | null;
}

export interface ItemHoldsView {
  projectKey: CaseKey;
  basis: { version: number; orderId: string | null } | null;
  items: ItemHoldView[];
  /** Approved furniture not held or captured yet. */
  toHoldCents: number;
  savedPayPal: boolean;
  /** Either account of the project may hold the rest with the client's saved PayPal. */
  canHold: boolean;
  reason: string | null;
}

export async function itemHoldsView(db: Db, sessionId: string | null, key: CaseKey, account: DemoAccount | null): Promise<ItemHoldsView> {
  const empty = (reason: string): ItemHoldsView => ({ projectKey: key, basis: null, items: [], toHoldCents: 0, savedPayPal: false, canHold: false, reason });
  if (!sessionId) return empty("Open this project from the browser that owns the demo case.");
  let basis;
  try { basis = await db.transaction((tx) => lockPaymentBasis(tx, sessionId, key)); }
  catch (error) {
    if (error instanceof PaymentActionError) return empty(error.message);
    throw error;
  }
  const { ledger, plan } = basis;
  const kinds = new Map((await db.select({ id: items.id, kind: items.kind }).from(items).where(eq(items.projectId, basis.projectId))).map((row) => [row.id, row.kind]));
  const now = Date.now();
  const lines = plan.lines.flatMap((line): ItemHoldView[] => {
    const businessId = basis.businessItem(line);
    if (!businessId || kinds.get(businessId) !== "furniture" || line.targetCents === 0) return [];
    const latest = ledger.operations.filter((operation) => operation.kind === "authorize" && operation.itemId === businessId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const hold = ledger.authorizations.filter((entry) => entry.itemId === businessId && (entry.status === "created" || entry.status === "partially_captured") && !(entry.expiresAt && entry.expiresAt.getTime() <= now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const funded = line.heldCents + line.capturedCents - line.refundedCents;
    const state = line.capturedCents - line.refundedCents >= line.targetCents ? "captured"
      : funded >= line.targetCents ? "held"
        : latest?.status === "pending" || latest?.status === "unknown" ? "holding"
          : latest?.status === "failed" ? "failed" : "to_hold";
    return [{
      itemId: line.itemId, label: line.label, targetCents: line.targetCents, heldCents: line.heldCents, capturedCents: line.capturedCents - line.refundedCents, state,
      paypalAuthorizationId: hold?.paypalAuthorizationId ?? null, expiresAt: hold?.expiresAt?.toISOString() ?? null,
      failureMessage: state === "failed" ? latest?.failureMessage ?? null : null,
    }];
  });
  const toHoldCents = lines.reduce((total, line) => total + Math.max(line.targetCents - line.heldCents - line.capturedCents, 0), 0);
  const [saved] = await db.select({ id: savedPaymentMethods.id }).from(savedPaymentMethods).where(eq(savedPaymentMethods.projectId, basis.projectId));
  const member = !!account && (account.role === "designer" || account.projectKey === key);
  const canHold = member && !!saved && (toHoldCents > 0 || lines.some((line) => line.state === "holding"));
  const reason = !lines.length ? "The client has not approved a furniture item yet."
    : toHoldCents === 0 ? null
      : !saved ? "Items are held with the PayPal the client saves when paying the design services."
        : !member ? "Only the project's client or designer can hold items."
          : null;
  return { projectKey: key, basis: { version: basis.version, orderId: basis.orderId }, items: lines, toHoldCents, savedPayPal: !!saved, canHold, reason };
}
