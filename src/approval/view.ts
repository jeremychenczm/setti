import type { ChangeOrderView, FrozenChangeOrder } from "../pricing/types";
import type { changeOrderDecisions } from "./schema";
import type { ClientDecision } from "./types";

export function clientDecision(row: typeof changeOrderDecisions.$inferSelect): ClientDecision {
  return { id: row.id, orderId: row.orderId, decision: row.decision, clientName: row.clientName, signature: row.signature, note: row.note, decidedAt: row.decidedAt.toISOString(), contentHash: row.contentHash, revisionContentHash: row.revisionContentHash, isDemo: true };
}

export function changeOrderView(document: FrozenChangeOrder, status: string, decision?: typeof changeOrderDecisions.$inferSelect): ChangeOrderView {
  return {
    order: document,
    status: status === "superseded" ? "superseded" : status === "approved" ? "approved" : status === "declined" ? "declined" : "awaiting_client_confirmation",
    decision: decision ? clientDecision(decision) : null,
  };
}
