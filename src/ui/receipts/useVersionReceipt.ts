"use client";

import { useEffect, useState } from "react";
import type { VersionReceipt } from "@/receipts/types";

/** `stale` marks a receipt shown while a newer one, asked for by a new `refresh`, is still loading. */
export type ReceiptLoad = { receipt: VersionReceipt; stale?: boolean } | { error: string } | null;

/** The record behind a version's formal document, as the JSON download serves it. */
export function receiptSource(projectKey: string, version: string | number): string {
  return `/api/receipts/${encodeURIComponent(projectKey)}/${encodeURIComponent(String(version))}`;
}

/**
 * Loads a version's receipt, or its formal quote while the client has not
 * signed it. Null while loading or when not `enabled`; a new `refresh` value
 * loads it again, keeping the last one shown, marked stale, meanwhile.
 */
export function useVersionReceipt(projectKey: string, version: string | number, { enabled = true, refresh = "" }: { enabled?: boolean; refresh?: string } = {}): ReceiptLoad {
  const [loaded, setLoaded] = useState<{ load: ReceiptLoad; key: string } | null>(null);
  const source = receiptSource(projectKey, version);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const key = `${source} ${refresh}`;
    fetch(source, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!controller.signal.aborted) setLoaded({ key, load: response.ok ? { receipt: body as VersionReceipt } : { error: body?.error ?? "This document could not be loaded." } });
      })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ key, load: { error: "Connection interrupted. Reload to try again." } }); });
    return () => controller.abort();
  }, [source, enabled, refresh]);
  if (!enabled || !loaded) return null;
  const current = loaded.key === `${source} ${refresh}`;
  if (current) return loaded.load;
  // Another version's document is never shown in its place; the same version's earlier state is, marked stale.
  return loaded.key.startsWith(`${source} `) && loaded.load && "receipt" in loaded.load ? { ...loaded.load, stale: true } : null;
}
