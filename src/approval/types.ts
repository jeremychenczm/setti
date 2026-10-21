import type { ChangeOrderView } from "../pricing/types";
import type { FundingPlan } from "./funding";

export interface ClientDecision {
  id: string;
  orderId: string;
  decision: "approved" | "changes_requested";
  clientName: string;
  signature: string;
  note: string;
  decidedAt: string;
  contentHash: string;
  revisionContentHash: string;
  isDemo: true;
}

export interface DecideChangeOrderInput {
  decision: ClientDecision["decision"];
  contentHash: string;
  revisionContentHash: string;
  acknowledged: true;
  signature: string;
  note: string;
}

export interface ApprovalWorkspace {
  view: ChangeOrderView;
  canDecide: boolean;
  clientName: string | null;
  reason: string | null;
  fundingPlan: FundingPlan | null;
}
