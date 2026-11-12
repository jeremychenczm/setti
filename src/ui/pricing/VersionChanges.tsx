import type { VersionReceipt } from "@/receipts/types";
import { changeRows } from "../receipts/receipt-view";

const th = "border-b border-[var(--ink)] px-1.5 py-2 text-[11px] font-semibold text-[var(--muted)] first:pl-0 last:pr-0";
const td = "border-b border-[var(--line)] px-1.5 py-2.5 align-top first:pl-0 last:pr-0";
const num = "text-right tabular-nums whitespace-nowrap";
const tone = (cents: number) => cents < 0 ? "text-emerald-700" : "";

/** Dollars, without cents when every amount in the table is whole. */
function formatter(amounts: number[]) {
  const digits = amounts.every((cents) => cents % 100 === 0) ? 0 : 2;
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
  const usd = (cents: number) => format.format(cents / 100);
  return { usd, signed: (cents: number) => cents === 0 ? usd(0) : `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}` };
}

/**
 * What a version changes, beside its formal quote: each item before and after
 * with the difference, then the totals. Read from the same record as the
 * document, so the amounts on both sides agree, old items' fees included.
 */
export function VersionChanges({ receipt }: { receipt: VersionReceipt }) {
  const { agreement, version, totals } = receipt;
  if (agreement.kind !== "change") return null;
  const rows = changeRows(agreement.changes);
  const unchanged = agreement.unchanged.reduce((sum, line) => sum + line.totalCents, 0);
  const { usd, signed: signedUsd } = formatter([...rows.flatMap((row) => [row.beforeCents ?? 0, row.afterCents ?? 0]), unchanged, totals.previousCents ?? 0, totals.totalCents]);
  return <section aria-labelledby="version-changes-title" className="grid gap-3 rounded-xl bg-white p-5 shadow-sm sm:p-6">
    <h2 id="version-changes-title" className="text-[14px] font-semibold">What changed from V{version.basedOn}</h2>
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead><tr>
          <th scope="col" className={`${th} text-left`}>Item</th>
          <th scope="col" className={`${th} text-right`}>V{version.basedOn}</th>
          <th scope="col" className={`${th} text-right`}>V{version.number}</th>
          <th scope="col" className={`${th} text-right`}>Change</th>
        </tr></thead>
        <tbody>
          {rows.map(({ change, beforeCents, afterCents, changeCents, summary }, index) => <tr key={index}>
            <th scope="row" className={`${td} text-left font-semibold`}>{(change.after ?? change.before)?.name}<span className="mt-0.5 block text-[11.5px] font-normal text-[var(--muted)]">{summary}</span></th>
            <td className={`${td} ${num}`}>{beforeCents === null ? "—" : usd(beforeCents)}</td>
            <td className={`${td} ${num}`}>{afterCents === null ? "—" : usd(afterCents)}</td>
            <td className={`${td} ${num} ${tone(changeCents)}`}>{signedUsd(changeCents)}</td>
          </tr>)}
          {agreement.unchanged.length > 0 && <tr className="text-[var(--muted)]">
            <th scope="row" className={`${td} text-left font-medium`}>{agreement.unchanged.length === 1 ? agreement.unchanged[0].name : `${agreement.unchanged.length} other lines`}<span className="mt-0.5 block text-[11.5px] font-normal">Unchanged</span></th>
            <td className={`${td} ${num}`}>{usd(unchanged)}</td>
            <td className={`${td} ${num}`}>{usd(unchanged)}</td>
            <td className={`${td} ${num}`}>{usd(0)}</td>
          </tr>}
          <tr className="font-bold">
            <th scope="row" className="pt-2.5 pr-1.5 text-left">Quote total</th>
            <td className={`px-1.5 pt-2.5 ${num}`}>{usd(totals.previousCents ?? 0)}</td>
            <td className={`px-1.5 pt-2.5 ${num}`}>{usd(totals.totalCents)}</td>
            <td className={`pl-1.5 pt-2.5 ${num} ${tone(totals.differenceCents ?? 0)}`}>{signedUsd(totals.differenceCents ?? 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>;
}
