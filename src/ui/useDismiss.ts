"use client";

import { useEffect, type RefObject } from "react";

/** Closes an open popover when the user clicks anywhere outside it or presses Escape. */
export function useDismiss(root: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [root, open, setOpen]);
}
