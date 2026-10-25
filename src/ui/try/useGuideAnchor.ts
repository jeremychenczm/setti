"use client";

import { useEffect } from "react";

const GUIDE_ANCHORS = new Set(["client-decision-title", "payments", "design-services", "item-holds", "pricing-source-status"]);

/** A role cookie change must reload server-rendered permissions even on the same URL. */
export function navigateGuidePage(path: string, changedRole: boolean): void {
  const target = new URL(path, window.location.origin);
  if (changedRole && target.pathname === window.location.pathname) {
    window.history.replaceState(window.history.state, "", `${target.pathname}${target.search}${target.hash}`);
    window.location.reload();
  } else window.location.assign(path);
}

/** A full-page navigation can reach its hash before the async quote/payment UI exists. */
export function useGuideAnchor(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const target = window.location.hash.slice(1);
    if (!GUIDE_ANCHORS.has(target) && !/^payment-line-(?:baseline|proposed)-[\w:-]+$/.test(target)) return;
    const scroll = () => {
      const element = document.getElementById(target);
      if (!element) return false;
      element.scrollIntoView({ block: "start" });
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => { if (scroll()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 10_000);
    return () => { observer.disconnect(); window.clearTimeout(timeout); };
  }, [enabled]);
}
