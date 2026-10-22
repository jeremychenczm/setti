import { LoaderCircle, RefreshCw } from "lucide-react";
import { summarizePaymentFees } from "../../payments/fee-summary";
import type { PaymentLineView } from "../../payments/types";

const money = (value: number | null) => value === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const observed = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })
  : null;

interface PaymentFeesProps {
  lines: readonly PaymentLineView[];
  /** Present only for the owning browser; reads seller breakdowns again with GET requests. */
  onRefresh?: () => void;
  refreshing?: boolean;
  disabled?: boolean;
}

export function PaymentFees({ lines, onRefresh, refreshing = false, disabled = false }: PaymentFeesProps) {
  const summary = summarizePaymentFees(lines);
  const completed = summary.completedCaptureCount + summary.completedRefundCount;
  const pending = summary.pendingCaptureCount + summary.pendingRefundCount;
  return <section aria-labelledby="payment-fees-title" className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 id="payment-fees-title" className="mr-auto text-[13px] font-semibold text-slate-900">PayPal fees and merchant net</h3>
      {onRefresh && completed > 0 && <button type="button" onClick={onRefresh} disabled={disabled} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 underline disabled:opacity-50">{refreshing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}Read fees from PayPal</button>}
    </div>
    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">Recorded completed transactions for the items shown here. Seller amounts come from saved PayPal breakdowns; this view does not query PayPal.{onRefresh && completed > 0 ? " Reading fees sends GET requests for these captures and refunds only; it runs no payment step." : ""}</p>
    {completed > 0 ? <>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">{[
        { label: "PayPal fees charged", value: summary.captureFeeCents, count: summary.completedCaptureCount },
        { label: "Fees credited on refunds", value: summary.refundFeeCents, count: summary.completedRefundCount },
        { label: "Merchant net · recorded completed transactions", value: summary.merchantNetCents, count: completed },
      ].map((tile) => <div key={tile.label} className="rounded-lg border border-slate-100 bg-white p-3"><p className="text-[10px] text-slate-500">{tile.label}</p><p className="mt-1 text-[17px] font-semibold tabular-nums text-slate-900">{tile.count ? money(tile.value) : "None recorded"}</p></div>)}</div>
      {summary.merchantNetCents === null && <p role="status" className="mt-3 text-[11px] leading-relaxed text-amber-900">A completed transaction has a missing, unsupported or inconsistent seller breakdown. Merchant net is unknown; missing fees are not zero.</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">Merchant net = reported capture credits − reported refund debits. A refund fee component is a fee credit, not a new processing charge. Supplier costs and other expenses are separate; this is neither profit nor an account balance.</p>
      <details className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-[11px] font-medium text-slate-700">Seller breakdown evidence · {completed} completed transaction{completed === 1 ? "" : "s"}</summary>
        <ul className="mt-3 space-y-3">{summary.rows.map((row, index) => {
          const time = observed(row.observedAt);
          return <li key={`${row.kind}:${row.resourceId}:${index}`} className="border-t border-slate-100 pt-3 text-[11px] leading-relaxed first:border-0 first:pt-0">
            <p className="font-medium text-slate-800">{row.label} · {row.kind === "capture" ? "Capture credit" : "Refund debit"}</p>
            <p className="mt-0.5 break-all font-mono text-[10px] text-slate-500">PayPal {row.kind} {row.resourceId || "ID unavailable"}</p>
            {row.state === "reported" ? <><p className="mt-1 text-slate-600">Gross {money(row.grossCents)} · {row.kind === "capture" ? "Fee charged" : "Fee credit"} {money(row.feeCents)} · {row.kind === "capture" ? "Merchant credit" : "Merchant debit"} {money(row.netCents)}</p>
              {row.reason && <p className="mt-1 text-[10px] text-amber-900">{row.reason}</p>}</>
              : <p className="mt-1 text-amber-900">Unknown · {row.reason}</p>}
            <p className="mt-1 text-[10px] text-slate-500">{time ? <>Observed <time dateTime={row.observedAt!}>{time}</time> PT</> : "No recorded seller-breakdown observation time."}</p>
          </li>;
        })}</ul>
      </details>
    </> : <p className="mt-3 rounded-lg bg-white p-3 text-[12px] leading-relaxed text-slate-600">No completed capture or refund records are shown. Fees and merchant net are not established; this does not mean the project is paid or settled.</p>}
    {pending > 0 && <p role="status" className="mt-3 text-[11px] leading-relaxed text-amber-900">{summary.pendingCaptureCount} pending capture{summary.pendingCaptureCount === 1 ? "" : "s"} and {summary.pendingRefundCount} pending refund{summary.pendingRefundCount === 1 ? "" : "s"} excluded. Their outcomes and final seller amounts are not settled.</p>}
  </section>;
}
