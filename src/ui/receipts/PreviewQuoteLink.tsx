import { Eye } from "lucide-react";

/** Opens a sent version's formal document in a new tab: its A4 quote, or its signed receipt once the client has signed. */
export function PreviewQuoteLink({ projectKey, version }: { projectKey: string; version: number }) {
  return <a href={`/receipts/${projectKey}/${version}`} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--canvas)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]">
    <Eye aria-hidden className="h-3.5 w-3.5" />Preview formal quote<span className="sr-only"> (opens in a new tab)</span>
  </a>;
}
