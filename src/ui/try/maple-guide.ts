import type { AccountId } from "@/accounts/demo";
import type { CaseSnapshot } from "@/chat/types";
import type { PaymentLineView, PaymentsWorkspace } from "@/payments/types";
import type { PricingWorkspace } from "@/pricing/types";
import { MAPLE_MIXED_CHANGE_MESSAGE } from "@/demo/maple-materials";
import { isHomeScenario } from "@/demo/living-dining";
import { lineProgress } from "../payments/progress";

export const MAPLE_EXAMPLE_REQUEST = MAPLE_MIXED_CHANGE_MESSAGE;
export const MAPLE_GUIDE_STEPS = ["Ask for the change", "Check pricing", "Confirm the version", "Move money", "Explain the evidence"] as const;
export const HOME_GUIDE_STEPS = ["Discuss the layout", "Review the AI estimate", "Confirm the version", "Move money", "Explain the evidence"] as const;

export interface MapleGuideData {
  seedOrderId: string | null;
  scenario?: string;
  preparationPending?: boolean;
  snapshot: Pick<CaseSnapshot, "activeMessageId" | "messages" | "draft" | "draftPreparing" | "versions" | "aiConfigured">;
  pricing: Pick<PricingWorkspace, "review" | "preview" | "stale"> | null;
  /** The open pricing form can explicitly adopt a draft before its next save. */
  pricingViewStale?: boolean;
  payments: PaymentsWorkspace | null;
}

export interface MapleGuideStep {
  index: number;
  title: string;
  detail: string;
  role: AccountId;
  destination: "chat" | "pricing" | "order";
  orderId?: string;
  anchor?: string;
  action: string;
  complete?: boolean;
  chatAction?: "ask-payments";
}

/** Progress is derived from saved records, never from which tour buttons were clicked. */
export function mapleGuideStep(data: MapleGuideData, currentRole: "designer" | "client"): MapleGuideStep {
  const { snapshot, seedOrderId, pricing, payments } = data;
  const versions = [...(snapshot.versions ?? [])].filter((version) => version.id !== seedOrderId).sort((a, b) => b.version - a.version);
  const latest = versions[0];
  const draftPending = !!snapshot.draft && !snapshot.versions?.some((version) => version.fromCurrentDraft);
  const home = isHomeScenario(data.scenario);
  const chat = { index: 0, role: home ? "jordan" as const : "emma" as const, destination: "chat" as const, action: "Open the project chat" };
  if (snapshot.activeMessageId && latest?.status !== "approved") return { ...chat, title: "The AI request is still running", detail: "Wait for the saved result in the chat. No pricing review, client confirmation or payment is completed by this request." };
  const pricingStale = data.pricingViewStale ?? pricing?.stale;
  if ((draftPending || snapshot.draftPreparing) && pricingStale) return {
    index: 1, role: "jordan", destination: "pricing", anchor: "pricing-source-status", action: "Find Re-price from the latest draft",
    title: "Adopt the latest draft before reviewing its prices",
    detail: "The saved pricing review still uses an earlier draft or quote snapshot. Select Re-price from the latest draft in the notice before checking the rows. This explicit action replaces local pricing edits; it does not confirm prices or send a client version.",
  };
  if (draftPending || snapshot.draftPreparing) return {
    index: 1, role: "jordan", destination: "pricing", action: "Review pricing",
    title: pricing?.preview?.ready && !pricingStale ? data.preparationPending ? "Review the checked prices while payment setup finishes" : "Review the checked prices and send the version" : home ? "Jordan reviews the AI's five proposed changes" : "Jordan checks the proposed change",
    detail: home ? `Compare the AI-selected products and source prices with the sample supplier documents. Check all five changes, the sideboard return cost and the unchanged design fee, then resolve open questions.${data.preparationPending ? " You can save the review now; sending the revised version becomes available when the starting payment records are ready." : " Send one version to Emma when ready."}` : "Verify each changed item's details, old-item handling and any return cost, resolve the open items, then send one frozen version to Emma. The draft itself is not an order or a payment.",
  };
  if (latest?.status === "awaiting_client_confirmation") return {
    index: 2, role: "emma", destination: "order", orderId: latest.id, anchor: "client-decision-title", action: `Review and confirm V${latest.version}`,
    title: `Emma reviews the exact V${latest.version} agreement`, detail: "Read the scope, prices, retained costs and planned payment steps. Type the signature and confirm only when ready. Switching accounts does not sign anything.",
  };
  if (latest?.status === "declined") return { ...chat, index: 1, role: "jordan", title: "Emma asked for changes", detail: "Discuss the client's feedback in the chat and prepare a revised draft before requesting confirmation again." };
  if (latest?.status === "approved") {
    if (!payments || payments.orderId !== latest.id) return { index: 3, role: currentRole === "client" ? "emma" : "jordan", destination: "order", orderId: latest.id, anchor: "payments", action: `Open V${latest.version} payments`, title: "Read this version's payment records", detail: "Client confirmation is saved. Payment results have not been loaded here yet; approval alone does not establish a charge, release or refund." };
    const changed = mapleChangeLines(payments);
    const settled = payments.current && !!payments.plan && payments.plan.status !== "blocked" && changed.length > 0 && changed.every((line) => lineProgress(line, payments.operations).settled)
      && !payments.operations.some((operation) => operation.status === "pending" || operation.status === "unknown");
    if (settled) {
      const latestRecord = payments.operations.reduce((value, operation) => Math.max(value, Date.parse(operation.updatedAt) || 0), 0);
      const explanation = [...snapshot.messages].reverse().find((message) => message.moneyAnswer?.quoteId === latest.id && Date.parse(message.moneyAnswer.checkedAt) >= latestRecord);
      const explained = !!explanation;
      return { index: 4, role: currentRole === "client" ? "emma" : "jordan", destination: "chat", action: snapshot.activeMessageId ? "View conversation" : explained ? "View payment explanation" : "Ask @AI about payments", complete: explained,
        chatAction: !explained && !snapshot.activeMessageId ? "ask-payments" : undefined, anchor: explanation ? `case-message-${explanation.id}` : undefined,
        title: snapshot.activeMessageId ? "The AI is preparing the payment explanation" : explained ? "The recorded payment explanation is available" : "Explain why the quote difference is not today's payment",
        detail: snapshot.activeMessageId ? "The money records remain saved while the model selects relevant evidence. Wait for the result in the chat; no payment is executed by this question." : explained ? "Open the evidence answer in the chat and follow its source links. These are recorded Sandbox results for the shown items, not a full-project settlement." : "Select Ask @AI about payments to send the question in your chat. The AI selects evidence from the stored PayPal results; the answer is not a live PayPal balance check.",
      };
    }
    const available = changed.flatMap((line) => line.steps.filter((step) => step.available).map((step) => ({ line, step })))[0];
    const waiting = changed.find((line) => !lineProgress(line, payments.operations).settled);
    const progress = waiting ? lineProgress(waiting, payments.operations) : null;
    const clientNeeded = progress?.label === "Authorization needed" || progress?.label === "Additional authorization needed" || progress?.label === "Awaiting client approval";
    return { index: 3, role: available ? available.step.actor === "client" ? "emma" : "jordan" : clientNeeded ? "emma" : "jordan", destination: "order", orderId: latest.id, anchor: "payments", action: `Continue V${latest.version} payments`,
      title: "Each item keeps its own payment progress", detail: payments.plan?.status === "blocked" ? "Check unresolved existing operations before starting another payment. Pending and unknown results are not counted as completed." : available ? `${available.line.label}: ${available.step.note}` : progress?.next ?? payments.reason ?? "Open the recorded payment steps to see what is still needed.",
    };
  }
  const failed = [...snapshot.messages].reverse().find((message) => message.actor !== "assistant")?.aiState === "failed";
  if (home) return { ...chat, title: failed ? "The AI request needs attention" : "From the discussion to a revised quote", detail: failed ? "Your request is saved. Open the chat to inspect the error and retry it when ready." : !snapshot.aiConfigured ? "Read the sample discussion and supplier documents. Preparing a new AI estimate needs the server's model connection." : "Emma and Jordan have worked through five changes across the living and dining room. Read their discussion, then use Prepare the revised quote in Jordan's chat. AI reads the conversation and supplier documents to prepare the figures for review.", action: "Continue the discussion" };
  return { ...chat, title: failed ? "The AI request needs attention" : "Emma asks for one change affecting two items", detail: failed ? "The message is saved. Open the chat to inspect its error and retry the same request when ready. No successful draft is being assumed." : !snapshot.aiConfigured ? "The AI is not configured on this server. You can read the prepared history and payment evidence, but a new AI draft needs a working model connection." : "Ask to replace the lounge chair with a desk and return the rug. Start with the example or write your own request; you still choose when to send it." };
}

/** The change's displayed old/new item lines, excluding unrelated unchanged scope. */
export function mapleChangeLines(workspace: PaymentsWorkspace): PaymentLineView[] {
  return workspace.lines.filter((line) => line.changed);
}
