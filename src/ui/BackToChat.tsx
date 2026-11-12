import { ArrowLeft } from "lucide-react";

/** The way back from a full-page view of a project to its chat. */
export function BackToChat({ projectKey }: { projectKey: string }) {
  return <a href={`/chats/${projectKey}`} className="inline-flex shrink-0 items-center gap-1.5 border-b-2 border-[var(--ink)] px-0.5 py-1.5 text-[14px] font-semibold leading-none text-[var(--ink)] transition-colors hover:border-[var(--primary)] hover:text-[var(--primary)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)] motion-reduce:transition-none print:hidden">
    <ArrowLeft aria-hidden className="h-4 w-4" />Back to chat
  </a>;
}
