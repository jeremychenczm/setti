"use client";

import { useEffect, useState } from "react";
import type { VersionReceipt } from "@/receipts/types";

export type ReceiptLoad = { receipt: VersionReceipt } | { error: string } | null;

/** The record behind a version's formal document, as the JSON download serves it. */
export function receiptSource(projectKey: string, version: string | number): string {
  return `/api/receipts/${encodeURIComponent(projectKey)}/${encodeURIComponent(String(version))}`;
}

/**
 * Loads a version's receipt, or its formal quote while the client has not
 * signed it. Null while loading or when not `enabled`; a new `refresh` value
 * loads it again, keeping the last one shown meanwhile.
 */
export function useVersionReceipt(projectKey: string, version: string | number, { enabled = true, refresh = "" }: { enabled?: boolean; refresh?: string } = {}): ReceiptLoad {
  const [loaded, setLoaded] = useState<ReceiptLoad>(null);
  const source = receiptSource(projectKey, version);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(source, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!controller.signal.aborted) setLoaded(response.ok ? { receipt: body as VersionReceipt } : { error: body?.error ?? "This document could not be loaded." });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ error: "Connection interrupted. Reload to try again." }); });
    return () => controller.abort();
  }, [source, enabled, refresh]);
  return enabled ? loaded : null;
}
