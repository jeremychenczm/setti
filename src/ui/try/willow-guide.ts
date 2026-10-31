import type { AccountId } from "@/accounts/demo";
import type { CaseSnapshot } from "@/chat/types";
import type { ItemHoldsView } from "@/payments/item-holds-view";
import type { ServicesPaymentView } from "@/payments/services-view";

export const WILLOW_GUIDE_STEPS = ["Send V1", "Sign selected lines", "Pay services", "Hold each item", "Confirm and capture"] as const;

export interface WillowGuideData {
  snapshot: Pick<CaseSnapshot, "opening" | "versions">;
  services: ServicesPaymentView | null;
  holds: ItemHoldsView | null;
}

export interface WillowGuideStep {
  index: number;
  title: string;
  detail: string;
  role: AccountId;
  destination: "chat" | "quote" | "order";
  action: string;
  anchor?: "design-services" | "item-holds" | "payments" | "client-decision-title";
  orderId?: string;
  complete?: boolean;
}

/** Paying and saving a wallet are separate observed facts, not consequences of a signature. */
export function willowGuideStep(data: WillowGuideData, currentRole: "designer" | "client"): WillowGuideStep {
  const { opening, versions } = data.snapshot;
  const { services, holds } = data;
  if (opening.closed) {
    const latest = [...(versions ?? [])].sort((a, b) => b.version - a.version)[0];
    if (latest) return { index: 1, title: `V${latest.version} replaced the opening quote`, detail: "Use the latest version's confirmation and payment records. The original V1 remains a historical record; this guide does not treat it as a new payment request or assume its payment steps completed.", role: latest.status === "awaiting_client_confirmation" ? "sofia" : "jordan", destination: "order", orderId: latest.id, anchor: latest.status === "awaiting_client_confirmation" ? "client-decision-title" : "payments", action: `Open V${latest.version}` };
    return { index: 1, title: "A newer version replaced V1", detail: "Open the conversation to find the current version. Do not make new decisions against this closed quote.", role: "jordan", destination: "chat", action: "Open the project chat" };
  }
  if (opening.status === "draft") return { index: 0, title: "Jordan sends the first quote", detail: "The supplier and service amounts are prepared demo inputs. Open the project chat and choose Send quote V1. No client decision or PayPal payment is prepared on your behalf.", role: "jordan", destination: "chat", action: "Open chat to send V1" };
  if (!opening.progress.approved) return { index: 1, title: "Sofia chooses which lines to approve", detail: "Try one design service and one furniture item first. Approve or decline only the lines you want, then type the signature to save those decisions. You can leave the other lines undecided; signing does not charge anything.", role: "sofia", destination: "quote", action: "Review and sign selected lines" };
  if (!services?.basis || !holds?.basis || services.basis.version !== holds.basis.version || services.basis.orderId !== holds.basis.orderId) return { index: 2, title: "Read the approved scope's payment records", detail: "Some lines are approved, but the guide has not loaded matching payment views for the same version. Open the quote to inspect its saved records before repeating a payment.", role: currentRole === "client" ? "sofia" : "jordan", destination: "quote", anchor: "design-services", action: "Inspect the recorded payments" };
  if (!services.services.length) return { index: 1, title: "Choose a design service before the wallet checkout", detail: "Only the approved lines form the agreement. No design service is approved yet. Sofia can sign a service line from V1; there is no need to approve every product or repeat an existing signature.", role: "sofia", destination: "quote", action: "Review the remaining service lines" };
  const pendingService = services.services.some((service) => service.captures.some((capture) => capture.status === "pending"));
  const unresolvedService = pendingService || (services.canCheck && !services.canPay);
  if (services.dueCents > 0 || pendingService || services.canCheck) return {
    index: 2, title: unresolvedService ? "Check the existing service payment" : services.canFinish ? "Finish the service captures from the existing hold" : "Sofia pays the approved design services",
    detail: unresolvedService ? "PayPal has an unresolved authorization or capture. Use Check PayPal status on the same payment; a pending result is not paid and must not become a replacement checkout." : services.canFinish ? "The authorization is recorded. Finish the remaining captures from that hold; the studio's services do not need a supplier confirmation." : "Use the PayPal or eligible Pay Later button. The checkout requests permission to save PayPal for this project's later item holds. The guide marks the wallet saved only if the provider result was recorded.",
    role: unresolvedService ? currentRole === "client" ? "sofia" : "jordan" : services.canFinish ? "jordan" : "sofia", destination: "quote", anchor: "design-services", action: "Open the service payment",
  };
  if (!holds.items.length) return { index: 1, title: "Choose a furniture item to continue", detail: "The saved PayPal is recorded, but there is no approved furniture item in this agreement yet. Sofia can sign a single remaining product line; the other quote lines can stay undecided.", role: "sofia", destination: "quote", action: "Review the remaining product lines" };
  if (!holds.savedPayPal && holds.items.some((item) => item.state === "to_hold" || item.state === "failed")) return {
    index: 3, title: "Sofia holds each approved item", role: "sofia", destination: "quote", anchor: "item-holds", action: "Hold the approved items",
    detail: "No payment method is saved for this project, so each approved item is held on its own with PayPal or the Sandbox test card. Saving the method on the first item lets the rest be held without another window. This guide does not suggest charging the services again.",
  };
  const clientNeeded = holds.items.find((item) => item.state === "awaiting_client");
  if (clientNeeded) return { index: 3, title: `${clientNeeded.label} needs Sofia on PayPal`, detail: "Continue that item's existing PayPal order, then check its result. The saved wallet does not mean every future hold is approved automatically.", role: "sofia", destination: "quote", anchor: "item-holds", action: "Continue the existing item hold" };
  if (holds.items.some((item) => item.state === "holding" || item.state === "unknown")) return { index: 3, title: "Check unresolved item holds", detail: "Keep each pending or unknown item attached to its existing PayPal operation. Use its Check action before starting additional holds.", role: "jordan", destination: "quote", anchor: "item-holds", action: "Inspect the same item holds" };
  if (holds.toHoldCents > 0) return { index: 3, title: "Jordan holds the approved furniture item amounts", detail: holds.canHold ? "Each approved furniture item gets its own PayPal authorization using the saved wallet. A hold reserves money; it does not mean the supplier was paid or the item was ordered." : holds.reason ?? "Inspect the item's recorded blocker before attempting its hold again.", role: "jordan", destination: "quote", anchor: "item-holds", action: "Open the item holds" };
  const unconfirmed = holds.items.find((item) => item.state === "held");
  if (unconfirmed) return { index: 4, title: `Jordan checks ${unconfirmed.label}'s supplier confirmation`, detail: "Record the demo supplier confirmation against the exact approved quantity, price, tax and delivery. Only then does the item's Capture action become available. This is a designer-entered record, not a live supplier integration.", role: "jordan", destination: "quote", anchor: "item-holds", action: "Record supplier confirmation below" };
  if (holds.items.some((item) => item.state === "confirmed")) return { index: 4, title: "Capture the supplier-confirmed items", detail: "Review and confirm each available capture. The real Sandbox result is saved per item, so one item's result cannot stand in for the rest of the project.", role: "jordan", destination: "quote", anchor: "item-holds", action: "Inspect and capture each ready item" };
  const complete = holds.items.every((item) => item.state === "captured");
  return { index: 4, title: complete ? "The selected services and items have recorded captures" : "Inspect the remaining item payment states", detail: complete ? "Inspect the provider records below. This completes only the selected approved scope. Undecided and declined lines remain separate; the demo does not claim the entire project is paid or delivered." : "Only a recorded completed capture establishes an item payment. Check the remaining states in the approved-items section.", role: "jordan", destination: "quote", anchor: "item-holds", action: "Inspect the payment records", complete };
}
