"use client";

import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

const actionLabels = { replace: "Replacement", quantity: "Quantity change", remove: "Removal", add: "New item" } as const;

/** Sent by the walkthrough guide: the pricing page opens its first unchecked change. */
export const OPEN_FIRST_CHANGE_EVENT = "setti:open-first-pricing-change";

/**
 * One change's full details in a dialog over the quote. Previous and Next move
 * through the changes without closing it.
 */
export function ChangeDrawer({ index, count, action, title, subtitle, onPrevious, onNext, onClose, footer, children }: {
  index: number;
  count: number;
  action: keyof typeof actionLabels;
  title: string;
  subtitle?: string;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  /** The designer's check for this change, kept in view below the scrolling details. */
  footer: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    // Escape inside the grid cancels a cell edit; it should not also close the drawer.
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest(".ag-root-wrapper"))) onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  // A small dialog in the middle of the page; the dimmed page behind it closes it.
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(36,38,32,0.45)] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <aside id="pricing-change-details" role="dialog" aria-modal="true" aria-labelledby="pricing-change-title" className="flex max-h-[min(720px,100%)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
    <header className="flex items-start gap-3 border-b border-[var(--line)] px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">Change {index + 1} of {count} · {actionLabels[action]}</p>
        <h2 id="pricing-change-title" className="mt-1 text-[15px] font-semibold leading-snug">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[11px] text-[var(--muted)]">{subtitle}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Close change details" className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--canvas)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
    </header>
    <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    <footer className="space-y-3 border-t border-[var(--line)] px-5 py-3">
      {footer}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPrevious} disabled={index === 0} className="inline-flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)] disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
        <span className="flex-1 text-center text-[11px] tabular-nums text-[var(--muted)]">{index + 1} / {count}</span>
        {/* After the last change, the drawer closes onto the save and send bar. */}
        {index === count - 1
          ? <button type="button" onClick={onClose} className="inline-flex items-center gap-1 rounded-lg bg-[var(--primary-fill)] px-3 py-1.5 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]"><Check className="h-3.5 w-3.5" />Done</button>
          : <button type="button" onClick={onNext} className="inline-flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)]">Next<ChevronRight className="h-3.5 w-3.5" /></button>}
      </div>
    </footer>
  </aside>
  </div>;
}
