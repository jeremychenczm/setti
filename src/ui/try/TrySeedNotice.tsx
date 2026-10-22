"use client";

import { CreditCard } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/** Says which money in this Maple project /try seeded, and how. */
export function TrySeedNotice() {
  const [orderId, setOrderId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/try", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { seed: { status: string; changeOrderId: string | null } | null } | null) => {
        if (active && body?.seed?.status === "ready") setOrderId(body.seed.changeOrderId);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  if (!orderId) return null;
  return (
    <div role="note" className="flex items-start gap-2 border-b border-blue-100 bg-blue-50/60 px-4 py-2.5 text-[11px] leading-relaxed text-slate-700 sm:px-5">
      <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
      <p className="flex-1">
        Prepared by /try: the $800 lounge chair hold and the $300 wool rug payment are real PayPal Sandbox transactions, approved with a Sandbox test card.{" "}
        <Link href={`/change-orders/${orderId}`} className="font-medium text-[var(--primary)] hover:underline">See them in Quote V2</Link>
      </p>
    </div>
  );
}
