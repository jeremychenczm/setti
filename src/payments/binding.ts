/**
 * The common entry for every payment action. It locks the demo case, checks
 * that the caller's session owns it, and returns the exact client-confirmed
 * version the action executes: the frozen document, both hashes, and the
 * business project and item identities behind its lines. A shared read-only
 * link, another session, a changed document or a superseded version never
 * reaches PayPal.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { revisions } from "../db/schema";
import { buildFundingPlan, type FundingPlan } from "../approval/funding";
import { fundingFactsFrom, fundingIdentities, readLedger, type ProjectLedger } from "../approval/store";
import { changeOrderDecisions } from "../approval/schema";
import { chatCases } from "../chat/schema";
import { changeOrderContentHash } from "../pricing/document";
import { changeOrders, pricingCases } from "../pricing/schema";
import type { FrozenChangeOrder } from "../pricing/types";
import type { OperationBinding } from "./operations";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentErrorCode =
  | "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT" | "CONTENT_CHANGED" | "NOT_CONFIRMED" | "STALE_VERSION"
  | "PLAN_BLOCKED" | "NOT_AVAILABLE" | "OPERATION_REFUSED" | "IDEMPOTENCY_CONFLICT" | "SUPPLIER_TERMS_CHANGED";

export class PaymentActionError extends Error {
  constructor(readonly code: PaymentErrorCode, message: string, readonly details: string[] = []) {
    super(message);
    this.name = "PaymentActionError";
  }
}

export interface ConfirmedVersion {
  order: FrozenChangeOrder;
  caseId: string;
  projectId: string;
  /** Quote line identity key → business item UUID, from the case's business project. */
  itemMapping: Record<string, string>;
  /** The binding an operation for this business item carries. */
  bind(itemId: string): OperationBinding;
}

/** Hashes the caller saw; both must still describe the frozen document. */
export interface ShownVersion {
  contentHash: string;
  revisionContentHash: string;
}

/**
 * Locks the case and loads the order the caller may act on. `requireCurrent`
 * insists on the latest client-confirmed version; reconciling an operation that
 * was already started skips that check so its result is still recorded against
 * the version it was started for.
 */
export async function lockConfirmedVersion(tx: Tx, sessionId: string, orderId: string, shown: ShownVersion | null, requireCurrent = true): Promise<ConfirmedVersion> {
  if (!UUID.test(sessionId)) throw new PaymentActionError("FORBIDDEN", "This share link is read-only. Open it from the browser that owns the demo case.");
  if (!UUID.test(orderId)) throw new PaymentActionError("NOT_FOUND", "This change order could not be found.");
  const [scope] = await tx.select({ caseId: changeOrders.caseId }).from(changeOrders).where(eq(changeOrders.id, orderId));
  if (!scope) throw new PaymentActionError("NOT_FOUND", "This change order could not be found.");
  const [caseRow] = await tx.select().from(chatCases).where(eq(chatCases.id, scope.caseId)).for("update");
  if (caseRow.sessionId !== sessionId) throw new PaymentActionError("FORBIDDEN", "This share link is read-only. Open it from the browser that owns the demo case.");
  const [row] = await tx.select().from(changeOrders).where(eq(changeOrders.id, orderId));
  const [revision] = await tx.select().from(revisions).where(eq(revisions.id, row.revisionId)).for("share");
  const order = row.document;
  const { contentHash, ...withoutHash } = order;
  if (row.contentHash !== contentHash || changeOrderContentHash(withoutHash) !== contentHash || revision.contentHash !== order.revisionContentHash
      || (shown && (shown.contentHash !== contentHash || shown.revisionContentHash !== order.revisionContentHash))) {
    throw new PaymentActionError("CONTENT_CHANGED", "The displayed version no longer matches the frozen change order. Reload before starting a payment step.");
  }
  const [decision] = await tx.select().from(changeOrderDecisions).where(and(eq(changeOrderDecisions.orderId, orderId), eq(changeOrderDecisions.decision, "approved")));
  if (!decision) throw new PaymentActionError("NOT_CONFIRMED", "Payment steps start only after the client confirms this exact version.");
  if (requireCurrent && revision.status !== "approved") {
    throw new PaymentActionError("STALE_VERSION", `A newer client-confirmed version replaced V${order.version}. Start payment steps from the current version.`);
  }
  const [bridge] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, scope.caseId));
  if (!bridge) throw new PaymentActionError("NOT_FOUND", "The business project for this change order is unavailable.");
  return {
    order, caseId: scope.caseId, projectId: bridge.projectId, itemMapping: bridge.itemMapping,
    bind: (itemId) => ({ changeOrderId: order.id, revisionId: order.revisionId, contentHash, revisionContentHash: order.revisionContentHash, itemId }),
  };
}

/** One funding line of a confirmed version: its quote item and which side of a replacement it is. */
export interface LineRef {
  itemId: string;
  side: "baseline" | "proposed";
}

/** The business item behind a line of the confirmed version. */
export function businessItem(version: ConfirmedVersion, line: LineRef): string {
  const id = fundingIdentities(version.order, version.itemMapping).byGroup.get(`${line.side}:${line.itemId}`);
  if (!id) throw new PaymentActionError("NOT_FOUND", "This line has no business item in the confirmed version.");
  return id;
}

/** The project's recorded money and the funding plan it gives for the confirmed version. */
export async function confirmedPlan(tx: Tx, version: ConfirmedVersion): Promise<{ ledger: ProjectLedger; plan: FundingPlan }> {
  const ledger = await readLedger(tx, version.projectId);
  return { ledger, plan: buildFundingPlan(version.order, fundingFactsFrom(version.order, version.itemMapping, ledger)) };
}
