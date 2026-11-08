/**
 * A live project on the desk, read from this browser session's recorded
 * PayPal Sandbox facts with the same views the payments pages use: the item
 * holds and design services of V1, or the payment lines of the latest
 * client-confirmed change order.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DemoAccount } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import type { Db } from "@/db/client";
import { changeOrderDecisions, changeOrders, chatCases, revisions } from "@/db/schema";
import { readOpening } from "@/opening/read";
import { itemHoldsView, type ItemHoldView } from "@/payments/item-holds-view";
import { servicesPaymentView, type ServiceChargeView } from "@/payments/services-view";
import type { PaymentLineView } from "@/payments/types";
import { paymentsWorkspace } from "@/payments/workspace";
import { lineProgress } from "@/ui/payments/progress";
import type { DeskItem, DeskProject, DeskWaitingOn } from "./types";

type Reader = Pick<Db, "select">;

/** Progress labels that ask the designer to act; the rest wait for the client or need nothing. */
const DESIGNER_STEPS = /^(?:Awaiting supplier (?:confirmation|credit)|Ready for capture|Refund required|Hold release required|Cancelled · hold not released yet|.* outcome unknown|.* in progress)$/u;
const CLIENT_STEPS = /^(?:Awaiting client approval|(?:Additional )?authorization needed|Authorization needed|Payment required)$/iu;

function waitingOn(label: string): DeskWaitingOn {
  if (DESIGNER_STEPS.test(label)) return "designer";
  if (CLIENT_STEPS.test(label)) return "client";
  return null;
}

/** A line of a confirmed change order, worded exactly as its payments panel words it. */
export function changeLineItem(line: PaymentLineView, operations: Parameters<typeof lineProgress>[1]): DeskItem {
  const progress = lineProgress(line, operations);
  const net = line.capturedCents - line.refundedCents;
  const refunding = progress.label === "Awaiting supplier credit" || progress.label === "Refund required";
  return {
    id: `${line.itemId}:${line.side}`, name: line.label, category: line.category,
    agreedCents: line.targetCents, heldCents: line.heldCents, chargedCents: line.capturedCents, refundedCents: line.refundedCents,
    toRefundCents: refunding ? Math.max(net - line.targetCents, 0) : 0,
    status: progress.label, next: progress.next, waitingOn: waitingOn(progress.label),
  };
}

const HOLD_STATES: Record<ItemHoldView["state"], [string, string, DeskWaitingOn]> = {
  captured: ["Payment completed", "This item's confirmed amount is charged.", null],
  confirmed: ["Ready for capture", "Charge the supplier-confirmed amount.", "designer"],
  held: ["Awaiting supplier confirmation", "Record the supplier's confirmation, then charge.", "designer"],
  holding: ["Authorization in progress", "The client is approving the hold on PayPal.", "client"],
  unknown: ["Authorization outcome unknown", "Check this item's existing PayPal operation before repeating it.", "designer"],
  failed: ["Authorization failed", "The client holds the item again.", "client"],
  awaiting_client: ["Awaiting client approval", "The client continues the PayPal checkout.", "client"],
  to_hold: ["Authorization needed", "The client holds this item with PayPal.", "client"],
  cancelled: ["Cancelled by the studio", "Nothing was charged for this item.", null],
};

/** An approved V1 furniture item, as the item-holds section shows it. */
export function heldItem(item: ItemHoldView): DeskItem {
  const [status, next, who] = HOLD_STATES[item.state];
  const releasing = item.state === "cancelled" && item.heldCents > 0;
  return {
    id: `${item.itemId}:${item.side}`, name: item.label, category: "furniture",
    agreedCents: item.state === "cancelled" ? 0 : item.targetCents, heldCents: item.heldCents, chargedCents: item.capturedCents, refundedCents: 0, toRefundCents: 0,
    status: releasing ? "Cancelled · hold not released yet" : status, next: releasing ? "Release this cancelled item's remaining hold." : next, waitingOn: releasing ? "designer" : who,
  };
}

/** An approved V1 design service. Held services are charged by the designer; unpaid ones wait for the client's checkout. */
export function serviceItem(service: ServiceChargeView, heldForServices: boolean): DeskItem {
  const due = Math.max(service.targetCents - service.capturedCents, 0);
  const base = { id: `${service.itemId}:baseline`, name: service.label, category: "service" as const, agreedCents: service.targetCents, chargedCents: service.capturedCents, refundedCents: 0, toRefundCents: 0 };
  if (!due) return { ...base, heldCents: 0, status: "Payment completed", next: "This service is charged.", waitingOn: null };
  if (heldForServices) return { ...base, heldCents: due, status: "Ready for capture", next: "Charge the approved design services.", waitingOn: "designer" };
  return { ...base, heldCents: 0, status: "Payment required", next: "The client pays the design services.", waitingOn: "client" };
}

const clientName = (value: string) => value.replace(/\s*\(demo client\)$/u, "");

export async function liveProject(db: Db, sessionId: string, key: CaseKey, account: DemoAccount, now = new Date()): Promise<DeskProject | null> {
  const reader: Reader = db;
  const [row] = await reader.select({ id: chatCases.id }).from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
  if (!row) return null;
  const opening = await readOpening(reader, { id: row.id, projectKey: key });
  const project = { id: key, name: opening.document.projectName, client: clientName(opening.document.clientName), source: "live" as const };

  const [approved] = await reader.select({ orderId: changeOrders.id, version: revisions.number }).from(changeOrders)
    .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
    .innerJoin(changeOrderDecisions, and(eq(changeOrderDecisions.orderId, changeOrders.id), eq(changeOrderDecisions.revisionId, revisions.id)))
    .where(and(eq(changeOrders.caseId, row.id), eq(changeOrderDecisions.decision, "approved")))
    .orderBy(desc(revisions.number)).limit(1);
  if (approved) {
    const workspace = await paymentsWorkspace(reader, sessionId, approved.orderId, now, account);
    if (workspace) {
      const items = workspace.lines.map((line) => changeLineItem(line, workspace.operations));
      if (workspace.others.lineCount) {
        items.push({
          id: "others", name: `${workspace.others.lineCount} unchanged item${workspace.others.lineCount === 1 ? "" : "s"}`, category: "furniture",
          agreedCents: workspace.others.targetCents, heldCents: 0, chargedCents: 0, refundedCents: 0, toRefundCents: 0,
          status: "Outside this change", next: "No payment step for this version.", waitingOn: null,
        });
      }
      return { ...project, stage: `V${workspace.version} confirmed`, version: workspace.version, agreedCents: items.reduce((total, item) => total + item.agreedCents, 0), proposedCents: null, items, href: `/change-orders/${approved.orderId}` };
    }
  }

  const holds = await itemHoldsView(db, sessionId, key, account);
  if (!holds.basis) {
    const sent = opening.opening.status === "sent";
    return { ...project, stage: sent ? "V1 with the client" : "V1 not sent yet", version: null, agreedCents: null, proposedCents: opening.opening.totalCents, items: [], href: `/quotes/${key}` };
  }
  const services = await servicesPaymentView(db, sessionId, key, account, null);
  const items = [...services.services.map((service) => serviceItem(service, services.canFinish)), ...holds.items.map(heldItem)];
  return { ...project, stage: "V1 approved", version: 1, agreedCents: items.reduce((total, item) => total + item.agreedCents, 0), proposedCents: null, items, href: `/quotes/${key}` };
}
