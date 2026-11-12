import type { OperationView, PaymentLineView } from "../../payments/types";

export interface LineProgress {
  label: string;
  tone: "waiting" | "ready" | "settled";
  next: string;
  settled: boolean;
}

/** One line can settle while another line of the same version still waits. */
export function lineProgress(line: PaymentLineView, operations: readonly OperationView[] = []): LineProgress {
  const result = (label: string, tone: LineProgress["tone"], next: string, settled = false): LineProgress => ({ label, tone, next, settled });
  // A replacement shares a quote itemId between its old and new sides. Only
  // the stable business identity can bind a payment result to either product.
  const open = line.businessItemId ? operations.filter((operation) => operation.businessItemId === line.businessItemId && (operation.status === "pending" || operation.status === "unknown")) : [];
  const unresolved = open.find((operation) => operation.status === "unknown") ?? open[0];
  if (unresolved) {
    const kind = { authorize: "Authorization", capture: "Capture", void: "Hold release", refund: "Refund", reauthorize: "Reauthorization" }[unresolved.kind];
    if (unresolved.status === "unknown") return result(`${kind} outcome unknown`, "waiting", "Check this item's existing PayPal operation before starting or repeating a payment step.");
    if (unresolved.kind === "authorize" && unresolved.approvalUrl) return result("Awaiting client approval", "waiting", "Continue this item's existing PayPal checkout, then check its recorded result.");
    return result(`${kind} in progress`, "waiting", "Check this item's existing payment operation; its result is not counted as completed yet.");
  }
  if (line.cancellation) return line.heldCents > 0
    ? result("Cancelled · hold not released yet", "waiting", "Release this cancelled item's remaining hold. Nothing was charged for it.")
    : result("Cancelled by the studio", "settled", `${line.cancellation.reasonText}. Nothing was charged, and nothing is held for it now.`, true);
  const net = line.capturedCents - line.refundedCents;
  if (line.refunds.some((refund) => refund.status === "pending")) return result("Refund pending at PayPal", "waiting", "Check the existing refund; pending money is not counted as returned.");
  if (line.captures.some((capture) => capture.status === "pending")) return result("Capture pending at PayPal", "waiting", "Check the existing capture before starting another payment.");
  if (net > line.targetCents) {
    const creditRequired = line.refundRequiresSupplierCredit ?? line.steps.some((step) => step.kind === "supplier_credit");
    return creditRequired && !line.supplierEvents.some((event) => event.kind === "credit_confirmed")
      ? result("Awaiting supplier credit", "waiting", "The designer records the supplier credit before refunding this item.")
      : result("Refund required", "ready", "Refund the excess paid on this item; other items keep their own progress.");
  }
  if (line.heldCents > 0 && net >= line.targetCents) return result("Hold release required", "ready", "Release this item's unused authorization. This does not refund captured money.");
  if (net + line.heldCents < line.targetCents) {
    return line.category === "furniture"
      ? result(line.heldCents > 0 || net > 0 ? "Additional authorization needed" : "Authorization needed", "waiting", "The client authorizes this item's uncovered amount on PayPal.")
      : result("Payment required", "waiting", "The client pays this service's remaining amount in the payment card on this page.");
  }
  if (line.heldCents > 0) {
    return !line.supplierEvents.some((event) => event.kind === "order_confirmed")
      ? result("Awaiting supplier confirmation", "waiting", "The designer confirms this item's supplier terms before capture.")
      : result("Ready for capture", "ready", "Capture this item's confirmed amount; release any unused hold when it closes.");
  }
  if (line.refundedCents > 0) return result("Refund completed", "settled", "This item's recorded net payment matches its confirmed amount.", true);
  if (line.capturedCents > 0) return result("Payment completed", "settled", "This item's recorded net payment matches its confirmed amount.", true);
  if (line.releasedCents > 0) return result("Hold released", "settled", "This item has no remaining hold or payment due under this version.", true);
  return result("No payment required", "settled", "No payment is due for this item under this version.", true);
}

export function paymentScopeTotals(lines: readonly PaymentLineView[]) {
  return lines.reduce((totals, line) => ({
    heldCents: totals.heldCents + line.heldCents,
    capturedCents: totals.capturedCents + line.capturedCents,
    refundedCents: totals.refundedCents + line.refundedCents,
    releasedCents: totals.releasedCents + line.releasedCents,
  }), { heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 0 });
}
