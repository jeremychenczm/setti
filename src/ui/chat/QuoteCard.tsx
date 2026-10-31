import { ChevronRight, FileText, LockKeyhole } from "lucide-react";
import type { AccountRole } from "@/accounts/demo";
import type { OpeningQuote } from "@/opening/types";
import { usd } from "../demo-data";

/** The quote V1 attached to the designer's message. */
export function QuoteCard({ opening, projectName, viewerRole, onOpen, replacedBy }: { opening: OpeningQuote; projectName: string; viewerRole: AccountRole; onOpen: () => void; replacedBy?: number | null }) {
  const { approved, pending } = opening.progress;
  const confirmed = approved === opening.lineCount;
  const label = confirmed ? "Approved by the client" : approved ? `Partially approved · ${approved} of ${opening.lineCount}` : pending ? "Awaiting client review" : "Declined by the client";
  return (
    <div className="mt-2.5 w-full max-w-sm overflow-hidden rounded-xl border border-brand-100 bg-white text-[var(--ink)] shadow-sm">
      <div className="flex items-start gap-3 p-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-[var(--primary)]"><FileText className="h-4.5 w-4.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Quote V{opening.version} · {projectName}</div>
          <div className="mt-0.5 text-[12px] text-slate-500">{opening.lineCount} items · <span className="font-medium tabular-nums text-slate-700">{usd(opening.totalCents)}</span></div>
          <span className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${approved ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{label}</span>
          {opening.closed && replacedBy && <span className="ml-1.5 mt-2 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">Replaced by V{replacedBy}</span>}
          {approved > 0 && !confirmed && <div className="mt-1 text-[11px] text-slate-500">Approved {usd(opening.progress.approvedTotalCents)}{pending ? ` · ${pending} undecided` : ""}</div>}
        </div>
      </div>
      <button onClick={onOpen} className="flex w-full items-center justify-between border-t border-brand-50 bg-brand-50/40 px-3.5 py-2.5 text-[12px] font-medium text-[var(--primary)] hover:bg-brand-50">
        {viewerRole === "client" && pending && !opening.closed ? "Review quote" : "View quote"}<ChevronRight className="h-3.5 w-3.5" />
      </button>
      {opening.sentAt && <div className="flex items-center gap-1 border-t border-brand-50 px-3.5 py-1.5 text-[10px] text-[var(--muted)]"><LockKeyhole className="h-3 w-3" />Locked when sent · {new Date(opening.sentAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
    </div>
  );
}
