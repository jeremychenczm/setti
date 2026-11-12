import type { FundingAction, FundingLine, FundingPlan } from "@/approval/funding";
import { notRefundedText } from "@/pricing/fees";
import type { ChangeOrderView, FrozenChangeOrder, ReviewedChange } from "@/pricing/types";
import { dateTime, money, shortMoney } from "./common";

interface FundingImpactPreviewProps {
  order: Pick<FrozenChangeOrder, "id" | "version" | "basedOnVersion" | "contentHash" | "deltaTotalCents"> & { changes?: readonly ReviewedChange[] };
  plan: FundingPlan | null;
  status: ChangeOrderView["status"];
  /** Shared quote links do not expose the owning case's payment records. */
  canView: boolean;
  /** The client's first name when the studio reads it; the client reads it as "you". */
  client?: string;
}

/** The client as the preview names them: "you" to the client, by name to the studio. */
function voiceOf(client?: string) {
  return client
    ? { confirms: `${client} confirms`, approves: `${client} approves`, pays: `${client} pays`, money: `${client}'s money` }
    : { confirms: "you confirm", approves: "you approve", pays: "You pay", money: "your money" };
}

/**
 * What a planned step does to the client's money, in the order they happen.
 * Each matches what Setti does with that kind of step: releases with nothing left
 * to charge and (with a saved method) new holds follow the confirmation itself;
 * charges wait for the supplier's confirmation and conditional refunds for its credit.
 */
const bucketsFor = ({ confirms, approves, pays }: ReturnType<typeof voiceOf>) => [
  { key: "hold", title: `Held after ${confirms}`, note: `With a saved payment method, Setti places them right after ${confirms}; otherwise ${approves} each with PayPal or a card. Each is charged only after its supplier confirms the order.` },
  { key: "release-now", title: `Released right after ${confirms}`, note: "These holds are no longer needed. A release isn't a refund: this money was held, never charged." },
  { key: "release-later", title: "Released once the supplier confirms", note: "The rest of the hold is charged after the supplier confirms; this part is then released." },
  { key: "charge-later", title: "Charged from a hold once the supplier confirms", note: "Already held. Each is charged only after its supplier confirms the order on these terms." },
  { key: "refund-credit", title: "Refunded once the supplier credits it", note: "Each refund waits for the supplier's credit. Fees the supplier keeps aren't refunded." },
  { key: "refund", title: "Refunded by the studio", note: "The studio sends these refunds through PayPal. Non-refundable fees stay charged." },
  { key: "pay", title: `${pays} through PayPal`, note: "Design services are paid together in one PayPal checkout." },
  { key: "charge-other", title: "Charged in a separate step", note: "This charge needs a separate payment step." },
] as const;
export type BucketKey = ReturnType<typeof bucketsFor>[number]["key"];

const designService = (line: FundingLine | undefined) => line?.category === "service" && (line.change === null || line.change === "add" || line.change === "quantity");

export function bucketOf(action: FundingAction, line: FundingLine | undefined): BucketKey {
  switch (action.kind) {
    case "new_authorization": return "hold";
    case "release_authorization": return action.timing === "on_payment_execution" ? "release-now" : "release-later";
    case "refund": return action.timing === "after_vendor_credit" ? "refund-credit" : "refund";
    case "capture": return action.timing === "after_vendor_confirmation" ? "charge-later" : designService(line) ? "pay" : "charge-other";
  }
}

/** Displays the server's plan by what happens to the money, without changing its amounts or enabling payment actions. */
export function FundingImpactPreview({ order, plan, status, canView, client }: FundingImpactPreviewProps) {
  const voice = voiceOf(client);
  const heading = !canView ? "Payments"
    : status === "superseded" ? "Historical payment plan"
      : status === "declined" ? "Payment plan for requested adjustments"
        : status === "approved" ? `What is left to happen to ${voice.money}`
          : client ? `What happens when ${voice.confirms} V${order.version}` : `What happens to your money if you confirm V${order.version}`;
  let unavailable: string | null = null;
  if (!canView) unavailable = "Payment records are available only in the browser that owns this demo case. This shared quote remains read-only.";
  else if (status === "superseded") unavailable = "This is a historical quote version. Review the latest client version for its current payment plan.";
  else if (status === "declined") unavailable = "Adjustments were requested for this version. The designer must issue a new version for review.";
  else if (!plan) unavailable = "Payment impact is unavailable from the saved records. Refresh the review or ask the designer to check it; the quote alone does not establish payment amounts.";
  else if (plan.orderId !== order.id || plan.version !== order.version || plan.basedOnVersion !== order.basedOnVersion || plan.contentHash !== order.contentHash || plan.quoteDeltaCents !== order.deltaTotalCents) unavailable = "The payment preview does not match this exact quote version. Refresh the review before relying on its amounts.";

  const headingId = `funding-impact-${order.id}`;
  const title = <h2 id={headingId} className="text-[13px] font-semibold">{heading}</h2>;
  if (unavailable || !plan) return <section className="grid gap-2" aria-labelledby={headingId}>
    {title}
    <p className="rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">{unavailable}</p>
    <p className="text-[11px] text-slate-500">No payment amounts are assumed.</p>
  </section>;

  const blocked = plan.status === "blocked" || plan.blockers.length > 0 || Object.values(plan.money).some((amount) => amount === null);
  const lineOf = (action: FundingAction) => plan.lines.find((line) => line.itemId === action.itemId && line.side === action.side);
  // A refund of an old item names what its supplier keeps.
  const kept = (action: FundingAction) => {
    const change = action.kind === "refund" && action.side === "baseline" ? order.changes?.find((entry) => entry.itemId === action.itemId) : undefined;
    return change && change.oldItemCostCents > 0 ? ` (${notRefundedText(change)})` : "";
  };
  const buckets = bucketsFor(voice).map((bucket) => ({ ...bucket, actions: plan.actions.filter((action) => bucketOf(action, lineOf(action)) === bucket.key) }))
    .filter((bucket) => bucket.actions.length > 0);

  return <section className="grid gap-3" aria-labelledby={headingId}>
    {title}
    {plan.status === "not_authorized" && <p className="rounded-lg bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">No PayPal funding records are saved for this project. Existing quote approvals do not count as payments.</p>}
    {blocked ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900">
      <h3 className="font-semibold">Payment amounts need verification</h3><p className="mt-1">New hold, charge, release and refund amounts are unavailable. An unknown outcome is not a zero balance.</p>
      {plan.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4">{plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
    </div> : buckets.length > 0 ? <ul className="border-t border-[var(--line)] tabular-nums">{buckets.map((bucket) => {
      const totalCents = bucket.actions.reduce((sum, action) => sum + action.amountCents, 0);
      const count = bucket.key === "hold" ? `${bucket.actions.length} new ${bucket.actions.length === 1 ? "hold" : "holds"}: ` : "";
      return <li key={bucket.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-[var(--line)] px-0.5 py-2.5">
        <h3 className="text-[13px] font-semibold">{bucket.title}</h3>
        <span className="whitespace-nowrap text-right text-[13px] font-semibold">{money(totalCents)}</span>
        <p className="col-span-2 text-[12px] leading-relaxed text-slate-600">{count}{bucket.actions.map((action) => `${action.label} ${shortMoney(action.amountCents)}${kept(action)}`).join(" · ")}. {bucket.note}</p>
      </li>;
    })}</ul> : <p className="text-[12px] text-slate-600">No payment steps are calculated from the saved records.</p>}
    <p className="text-[11px] leading-relaxed text-slate-500">A hold isn&apos;t a charge, and a release isn&apos;t a refund. Each item is its own PayPal step; these amounts are not one net payment.</p>
    <details className="text-[11px] text-slate-500"><summary className="cursor-pointer font-medium">Funding assumptions and conditions</summary><ul className="mt-2 list-disc space-y-1.5 pl-4">
      <li>Saved funding records read <time dateTime={plan.factsAsOf}>{dateTime(plan.factsAsOf)} PT</time>. This preview does not query PayPal live.{status === "approved" ? " Amounts are the remaining steps in the current saved records, not a snapshot taken at approval." : " Each step is checked again when it starts."}</li>
      {plan.notices.map((notice, index) => <li key={index}>{notice}</li>)}
    </ul></details>
  </section>;
}
