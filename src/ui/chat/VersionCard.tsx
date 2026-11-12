import { ChevronRight, FileDiff, LockKeyhole } from "lucide-react";
import Link from "next/link";
import type { AccountRole } from "@/accounts/demo";
import type { CaseKey, SentVersion } from "@/chat/types";
import { usd } from "../demo-data";
import { ChangeSourceNote } from "../pricing/ChangeSource";
import { quoteHref } from "@/quotes/links";

function signed(cents: number): string {
  return cents === 0 ? "no change" : `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

/** A later quote version attached to the designer's message that sent it. */
export function VersionCard({ version, projectKey, projectName, viewerRole, replacedBy }: { version: SentVersion; projectKey: CaseKey; projectName: string; viewerRole: AccountRole; replacedBy: number | null }) {
  const awaiting = version.status === "awaiting_client_confirmation";
  const label = version.status === "approved" ? "Confirmed by the client"
    : version.status === "declined" ? "The client asked for changes"
      : version.status === "superseded" ? `Replaced by V${replacedBy ?? version.version + 1}`
        : viewerRole === "client" ? "Awaiting your confirmation" : "Awaiting client confirmation";
  const tone = version.status === "approved" ? "bg-emerald-50 text-emerald-700" : version.status === "superseded" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800";
  return (
    <div className="mt-2.5 w-full max-w-sm overflow-hidden rounded-xl border border-brand-100 bg-white text-[var(--ink)] shadow-sm">
      <div className="flex items-start gap-3 p-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--primary)]"><FileDiff className="h-4.5 w-4.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Quote V{version.version} · {projectName}</div>
          <div className="mt-0.5 text-[12px] text-slate-500">{version.changeCount} line{version.changeCount === 1 ? "" : "s"} changed · <span className="font-medium tabular-nums text-slate-700">{usd(version.totalCents)}</span> <span className="tabular-nums">({signed(version.deltaTotalCents)} vs V{version.basedOnVersion})</span></div>
          {version.source && <div className="mt-0.5"><ChangeSourceNote source={version.source} /></div>}
          <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>
        </div>
      </div>
      <Link href={quoteHref(projectKey, version.version)} className="flex w-full items-center justify-between border-t border-brand-50 bg-brand-50/40 px-3.5 py-2.5 text-[12px] font-medium text-[var(--primary)] hover:bg-brand-50">
        {viewerRole === "client" && awaiting ? "Review and confirm" : `View V${version.version}`}<ChevronRight className="h-3.5 w-3.5" />
      </Link>
      <div className="flex items-center gap-1 border-t border-brand-50 px-3.5 py-1.5 text-[10px] text-[var(--muted)]"><LockKeyhole className="h-3 w-3" />Locked when sent · {new Date(version.issuedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{(version.status === "approved" || version.status === "declined") && <Link href={`/receipts/${projectKey}/${version.version}`} className="ml-auto font-medium text-[var(--primary)] hover:underline">Receipt</Link>}</div>
    </div>
  );
}
