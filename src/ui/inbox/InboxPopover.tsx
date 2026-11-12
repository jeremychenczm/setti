"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FOCUS } from "./parts";

const WIDTH = 380;
const GAP = 12;

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * A small card anchored to the row it explains: beside the grid's card when the
 * page has a side column, under the row when it does not, and a sheet from the
 * bottom on a phone. Esc, the close button or a click outside closes it; focus
 * moves into it on open and, closed from the keyboard or the button, back to
 * what opened it. Clicks the opener handles itself (`keepOpen`) leave it open.
 */
export function InboxPopover({ anchor, beside, title, subtitle, onClose, keepOpen, children }: {
  /** The row it points at; when the row is gone, it closes. */
  anchor: () => HTMLElement | null;
  /** The card it sits beside. */
  beside: () => HTMLElement | null;
  title: string;
  subtitle: string;
  onClose: () => void;
  keepOpen?: (target: Element) => boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const sheet = useMedia("(max-width: 639px)");
  const wide = useMedia("(min-width: 1280px)");
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number | null } | null>(null);

  const close = useCallback((restore: boolean) => {
    onClose();
    if (restore && opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
  }, [onClose]);

  useEffect(() => {
    opener.current = document.activeElement;
    // After the grid has finished focusing the cell that was clicked.
    const timer = window.setTimeout(() => {
      if (panel.current?.contains(document.activeElement)) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) opener.current = document.activeElement;
      panel.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panel.current?.contains(target) || keepOpen?.(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [close, keepOpen]);

  const position = useCallback(() => {
    if (sheet) return;
    const row = anchor(), box = beside(), card = panel.current;
    if (!row) { onClose(); return; }
    if (!box || !card) return;
    const at = row.getBoundingClientRect(), frame = box.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - 2 * GAP), height = card.offsetHeight;
    const bottom = window.innerHeight - height - GAP;
    if (wide) {
      // Beside the grid, over the side column, pointing at the row's middle.
      const middle = at.top + at.height / 2;
      const top = clamp(middle - 32, GAP, bottom);
      const arrow = middle - top - 6;
      setPlace({ left: clamp(frame.right - 28, GAP, window.innerWidth - width - GAP), top, arrow: arrow >= 12 && arrow <= height - 24 ? arrow : null });
    } else {
      const below = at.bottom + 6;
      setPlace({ left: clamp(frame.right - width - GAP, GAP, window.innerWidth - width - GAP), top: below + height <= window.innerHeight - GAP ? below : clamp(at.top - height - 6, GAP, bottom), arrow: null });
    }
  }, [anchor, beside, onClose, sheet, wide]);

  useLayoutEffect(() => {
    position();
    const observer = new ResizeObserver(() => position());
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [position]);

  const style = sheet ? undefined : place ? { left: place.left, top: place.top, width: `min(${WIDTH}px, calc(100vw - ${2 * GAP}px))` } : { left: 0, top: 0, visibility: "hidden" as const };
  return <>
    {sheet && <div aria-hidden className="fixed inset-0 z-40 bg-slate-900/20" />}
    <div ref={panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} style={style} className={`fixed z-50 outline-none ${sheet ? "inset-x-0 bottom-0" : ""}`}>
      <div className={`grid gap-2.5 border border-[var(--line)] bg-white p-3.5 text-[12px] ${sheet ? "max-h-[80dvh] overflow-y-auto rounded-t-2xl pb-6 shadow-2xl" : "max-h-[calc(100dvh-24px)] overflow-y-auto rounded-[14px] shadow-[0_18px_44px_-10px_rgba(30,32,28,0.35)]"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="grid min-w-0 gap-px">
            <h3 id={titleId} className="text-[14px] font-semibold">{title}</h3>
            <p className="text-[11px] text-[var(--muted)]">{subtitle}</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => close(true)} className={`rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)] ${FOCUS}`}><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
      {!sheet && place?.arrow != null && <span aria-hidden className="absolute -left-[6px] h-3 w-3 rotate-45 border-b border-l border-[var(--line)] bg-white" style={{ top: place.arrow }} />}
    </div>
  </>;
}
