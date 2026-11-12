"use client";

import { useEffect, useRef, useState } from "react";
import type { FundingPlan } from "@/approval/funding";
import type { ChangeOrderView, FrozenChangeOrder } from "@/pricing/types";
import { shortMoney } from "./common";
import { bucketOf, FundingImpactPreview, type BucketKey } from "./FundingImpactPreview";

/** A figure that counts from what it showed before to its new value. */
function useCounted(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    from.current = value;
    if (still || start === value) { setShown(value); return; }
    let frame = 0;
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 650);
      setShown(Math.round(start + (value - start) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

function Tile({ label, cents, sign, tone, caption }: { label: string; cents: number; sign: "+" | "−" | ""; tone: string; caption: string }) {
  const shown = useCounted(cents);
  return <div className="grid min-w-0 gap-0.5 rounded-[10px] bg-[var(--canvas)] px-3 py-2.5">
    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600"><i aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: tone }} />{label}</span>
    <b className="text-[22px] font-bold leading-tight tracking-tight tabular-nums">{sign && cents ? sign : ""}{shortMoney(shown)}</b>
    <span className="text-[11px] leading-snug text-[var(--muted)]">{caption}</span>
  </div>;
}

/**
 * The client's money for a version, before anything else on the page: what
 * signing holds, releases, asks them to pay and refunds later, as big figures.
 * The full plan, item by item, folds out below it.
 */
export function MoneyCard({ order, plan, status, canView }: {
  order: Pick<FrozenChangeOrder, "id" | "version" | "basedOnVersion" | "contentHash" | "deltaTotalCents" | "changes">;
  plan: FundingPlan | null; status: ChangeOrderView["status"]; canView: boolean;
}) {
  const sums = new Map<BucketKey, { cents: number; count: number }>();
  for (const action of plan?.actions ?? []) {
    const key = bucketOf(action, plan!.lines.find((line) => line.itemId === action.itemId && line.side === action.side));
    const entry = sums.get(key) ?? { cents: 0, count: 0 };
    sums.set(key, { cents: entry.cents + action.amountCents, count: entry.count + 1 });
  }
  const sum = (...keys: BucketKey[]) => keys.reduce((total, key) => total + (sums.get(key)?.cents ?? 0), 0);
  const blocked = !plan || plan.status === "blocked" || plan.blockers.length > 0 || Object.values(plan.money).some((amount) => amount === null);
  const details = <FundingImpactPreview order={order} plan={plan} status={status} canView={canView} />;
  if (!canView || blocked || status === "superseded" || status === "declined") return <section className="rounded-xl border border-[var(--line)] bg-white p-5">{details}</section>;

  const holds = sums.get("hold")?.count ?? 0;
  const signed = status === "approved";
  const tiles = [
    { key: "hold", label: signed ? "Still to hold" : "Held on your card", cents: sum("hold"), sign: "+" as const, tone: "#d7262e", caption: `${holds} ${holds === 1 ? "item" : "items"}, charged as each supplier confirms` },
    { key: "release", label: sum("release-now") ? "Released right away" : "Released later", cents: sum("release-now", "release-later"), sign: "−" as const, tone: "#047857", caption: sum("release-now") ? "Holds this version no longer needs" : "When the supplier confirms" },
    { key: "pay", label: signed ? "To pay" : "You pay after signing", cents: sum("pay", "charge-other"), sign: "" as const, tone: "#ffcc70", caption: "Design services, through PayPal" },
    { key: "refund", label: "Refunded later", cents: sum("refund", "refund-credit"), sign: "−" as const, tone: "#5b3d9a", caption: "When the supplier credits it" },
  ].filter((tile) => tile.cents > 0);
  return <section className="grid gap-3 rounded-xl border border-[var(--line)] bg-white p-4" aria-label="Your money">
    <div className="flex justify-between gap-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--muted)]"><span>Your money</span><span className="font-medium normal-case tracking-normal">{signed ? `Left to happen after V${order.version}` : `If you sign V${order.version}`}</span></div>
    {tiles.length ? <div className="grid grid-cols-2 gap-2">{tiles.map(({ key, ...tile }) => <Tile key={key} {...tile} />)}</div>
      : <p className="text-[12px] text-slate-600">No payment step is planned for this version.</p>}
    <p className="text-[11.5px] leading-relaxed text-[var(--muted)]">{signed ? "Each step appears in your Inbox when PayPal confirms it." : "Signing charges nothing by itself."} A hold isn&apos;t a charge, and a release isn&apos;t a refund.</p>
    <details className="text-[12px]"><summary className="cursor-pointer text-[11.5px] font-semibold text-[var(--primary)]">See every step, item by item</summary><div className="mt-3">{details}</div></details>
  </section>;
}
