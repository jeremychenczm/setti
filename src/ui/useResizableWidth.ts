"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * A right-hand panel the user widens or narrows by dragging its left edge (or
 * with the arrow keys). The width is a per-browser convenience kept in
 * localStorage; without storage the panel simply starts at its default width.
 */
export function useResizableWidth(storageKey: string, initial: number, min: number, keepForContent: number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = typeof window === "undefined" ? NaN : Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= min ? saved : initial;
    } catch {
      return initial;
    }
  });
  const row = useRef<HTMLDivElement>(null);
  const latest = useRef(width);

  function clamp(next: number): number {
    const available = row.current?.getBoundingClientRect().width ?? next + keepForContent;
    return Math.round(Math.min(Math.max(next, min), Math.max(min, available - keepForContent)));
  }

  function apply(next: number) {
    latest.current = clamp(next);
    setWidth(latest.current);
  }

  function remember() {
    try { window.localStorage.setItem(storageKey, String(latest.current)); } catch { /* Storage may be unavailable; the width still applies now. */ }
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    event.preventDefault();
    const move = (moved: globalThis.PointerEvent) => {
      const rect = row.current?.getBoundingClientRect();
      if (rect) apply(rect.right - moved.clientX);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      remember();
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    apply(latest.current + (event.key === "ArrowLeft" ? 32 : -32));
    remember();
  }

  return { width, rowRef: row, handleProps: { onPointerDown, onKeyDown } };
}
