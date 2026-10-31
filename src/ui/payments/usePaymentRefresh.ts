"use client";

import { useEffect } from "react";
import type { CaseKey } from "@/chat/types";

const eventName = "setti:payment-changed";

export function paymentChanged(projectKey: CaseKey) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: projectKey }));
}

/** Refresh the other payment sections and reconcile when returning from PayPal. */
export function usePaymentRefresh(projectKey: CaseKey, load: () => Promise<unknown>) {
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<CaseKey>).detail === projectKey) void load(); };
    const focused = () => { void load(); };
    window.addEventListener(eventName, changed);
    window.addEventListener("focus", focused);
    return () => {
      window.removeEventListener(eventName, changed);
      window.removeEventListener("focus", focused);
    };
  }, [projectKey, load]);
}
