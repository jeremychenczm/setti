import type { FundingAction, FundingPlan } from "@/approval/funding";
import type { ChangeOrderView, FrozenChangeOrder } from "@/pricing/types";
import { dateTime, money, signedMoney } from "./common";

interface FundingImpactPreviewProps {
  order: Pick<FrozenChangeOrder, "id" | "version" | "basedOnVersion" | "contentHash" | "deltaTotalCents">;
  plan: FundingPlan | null;
  status: ChangeOrderView["status"];
  /** Shared quote links do not expose the owning case's payment records. */
  canView: boolean;
}

const kinds = ["new_authorization", "capture", "release_authorization", "refund"] as const;
const labels: Record<FundingAction["kind"], string> = {
  new_authorization: "New authorization",
  capture: "Planned capture",
  release_authorization: "Authorization to release",
  refund: "Planned refund",
};
const timing: Record<FundingAction["timing"], string> = {
  on_payment_execution: "When the payment step is started",
  after_vendor_confirmation: "After supplier confirmation",
  after_vendor_credit: "After supplier credit is verified",
};
const identity = ({ side, itemId }: Pick<FundingAction, "side" | "itemId">) => `${side}:${itemId}`;
const total = (actions: FundingAction[], kind: FundingAction["kind"]) => actions.filter((action) => action.kind === kind).reduce((sum, action) => sum + action.amountCents, 0);

function ActionRows({ actions }: { actions: FundingAction[] }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[580px] border-collapse text-left text-[11px]">
    <thead><tr className="text-slate-500"><th className="py-2 pr-3 font-medium">Item</th><th className="py-2 pr-3 font-medium">Planned action</th><th className="py-2 pr-3 text-right font-medium">Amount</th><th className="py-2 pl-3 font-medium">Before it can happen</th></tr></thead>
    <tbody>{actions.map((action, index) => <tr key={`${identity(action)}:${action.kind}:${index}`} className="border-t border-blue-100 align-top">
      <td className="py-2.5 pr-3 font-medium text-slate-800">{action.label}<span className="mt-0.5 block text-[10px] font-normal text-slate-500">{action.side === "proposed" ? "New item" : "Existing item"}</span></td>
      <td className="py-2.5 pr-3">{labels[action.kind]}</td>
      <td className="whitespace-nowrap py-2.5 pr-3 text-right font-semibold tabular-nums">{money(action.amountCents)}</td>
      <td className="max-w-[340px] py-2.5 pl-3 text-slate-600"><p>{timing[action.timing]}{action.kind === "new_authorization" ? " · client approves on PayPal" : ""}</p><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{action.reason}</p></td>
    </tr>)}</tbody>
  </table></div>;
}

/** Displays the server's plan without changing its amounts or enabling payment actions. */
export function FundingImpactPreview({ order, plan, status, canView }: FundingImpactPreviewProps) {
  const heading = !canView ? "Payment impact"
    : status === "superseded" ? "Historical payment plan"
      : status === "declined" ? "Payment plan for requested adjustments"
        : status === "approved" ? "Remaining payment plan" : "Payment impact before you confirm";
  let unavailable: string | null = null;
  if (!canView) unavailable = "Payment records are available only in the browser that owns this demo case. This shared quote remains read-only.";
  else if (status === "superseded") unavailable = "This is a historical quote version. Review the latest client version for its current payment plan.";
  else if (status === "declined") unavailable = "Adjustments were requested for this version. The designer must issue a new version for review.";
  else if (!plan) unavailable = "Payment impact is unavailable from the saved records. Refresh the review or ask the designer to check it; the quote alone does not establish payment amounts.";
  else if (plan.orderId !== order.id || plan.version !== order.version || plan.basedOnVersion !== order.basedOnVersion || plan.contentHash !== order.contentHash || plan.quoteDeltaCents !== order.deltaTotalCents) unavailable = "The payment preview does not match this exact quote version. Refresh the review before relying on its amounts.";

  const headingId = `funding-impact-${order.id}`;
  if (unavailable || !plan) return <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 sm:p-6" aria-labelledby={headingId}>
    <h2 id={headingId} className="text-[16px] font-semibold">{heading} · V{order.version}</h2>
    <p className="mt-3 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">{unavailable}</p>
    <p className="mt-3 text-[11px] text-slate-500">No payment amounts are assumed. Confirming the quote does not move money.</p>
  </section>;

  const blocked = plan.status === "blocked" || plan.blockers.length > 0 || Object.values(plan.money).some((amount) => amount === null);
  const changed = new Set(plan.lines.filter((line) => line.changed).map(identity));
  const changedActions = plan.actions.filter((action) => changed.has(identity(action)));
  const otherActions = plan.actions.filter((action) => !changed.has(identity(action)));

  return <section className="mb-5 rounded-xl border border-blue-100 bg-white p-5 shadow-sm sm:p-6" aria-labelledby={headingId}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={headingId} className="text-[16px] font-semibold">{heading} · V{order.version}</h2><span className="rounded-full bg-blue-50 px-2.5 py-1 text-[10px] font-semibold text-blue-700">Plan only · no payment executed here</span></div>
    <p className="mt-2 text-[12px] leading-relaxed text-slate-600">The whole-quote budget changes by <strong className="font-semibold text-slate-900">{signedMoney(plan.quoteDeltaCents)}</strong> from V{plan.basedOnVersion}. This difference is not the amount to pay now. Each item&apos;s authorization, capture, release and refund is a separate step.</p>
    <p className="mt-2 text-[10px] text-slate-500">Saved funding records read <time dateTime={plan.factsAsOf}>{dateTime(plan.factsAsOf)} PT</time>. This preview does not query PayPal live.{status === "approved" ? " Amounts below are the remaining steps in the current saved records, not a snapshot taken at approval." : " Actual steps are checked again when started after confirmation."}</p>
    {plan.status === "not_authorized" && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">No PayPal funding records are saved for this project. Existing quote approvals do not count as payments.</p>}

    {blocked ? <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900">
      <h3 className="font-semibold">Payment amounts need verification</h3><p className="mt-1">New authorization, capture, release and refund amounts are unavailable. An unknown outcome is not a zero balance.</p>
      {plan.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4">{plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
    </div> : <>
      <h3 className="mt-4 text-[12px] font-semibold text-slate-800">Payment impact of changed items</h3>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{kinds.map((kind) => <div key={kind} className="rounded-lg bg-blue-50/60 p-3"><p className="text-[10px] text-slate-500">{labels[kind]}</p><p className="mt-1 text-[19px] font-semibold tabular-nums text-slate-900">{money(total(changedActions, kind))}</p></div>)}</div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">An authorization holds funds; it is not a charge. Releasing a hold is not a refund. These amounts are not combined into one net payment.</p>
      {changedActions.length > 0 ? <div className="mt-2"><ActionRows actions={changedActions} /></div> : <p className="mt-3 text-[12px] text-slate-600">No additional payment steps are calculated for the changed items from these saved records.</p>}

      {otherActions.length > 0 && <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/50 p-3">
        <h3 className="text-[12px] font-semibold text-amber-950">Other quote lines still need funding</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-amber-900">The changed-item amounts above exclude these unchanged quote lines. Their quote approval does not mean they have been paid. A separate payment step may be required.</p>
        <ActionRows actions={otherActions} />
      </div>}
    </>}
    <details className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500"><summary className="cursor-pointer font-medium">Funding assumptions and conditions</summary><ul className="mt-2 list-disc space-y-1.5 pl-4">{plan.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul></details>
    <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Confirming V{order.version} records agreement to scope, prices and terms. It does not authorize, capture, release or refund funds. Supplier confirmations and client PayPal approval remain separate requirements.</p>
  </section>;
}
