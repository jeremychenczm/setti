"use client";

import { LoaderCircle, LogOut } from "lucide-react";
import { useId, useRef, useState } from "react";

/** End an explicit walkthrough, keeping refreshes and role changes resumable. */
/** `large` is for the walkthrough bar, where ending the demo is a main control. */
export function EndDemoButton({ className = "", menuItem = false, large = false }: { className?: string; menuItem?: boolean; large?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const errorId = useId();

  async function endDemo() {
    if (working.current) return;
    working.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/try", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end" }),
      });
      const body = await response.json().catch(() => null) as { reset?: boolean; href?: string; error?: unknown } | null;
      if (!response.ok || body?.reset !== true || body.href !== "/") {
        throw new Error(typeof body?.error === "string" ? body.error : "The demo could not end. Try again; your progress is still saved.");
      }
      // A document navigation discards the previous workspace's local state; /try would start a new demo.
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The demo could not end. Try again.");
      setPending(false);
      working.current = false;
    }
  }

  return <span className="inline-flex flex-col items-start">
    <button type="button" role={menuItem ? "menuitem" : undefined} disabled={pending} onClick={() => void endDemo()}
      aria-describedby={error ? errorId : undefined} className={`inline-flex items-center gap-1.5 disabled:cursor-wait disabled:opacity-60 ${className}`}>
      {pending ? <LoaderCircle className={`${large ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} shrink-0 animate-spin`} aria-hidden="true" /> : <LogOut className={`${large ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} shrink-0`} aria-hidden="true" />}
      {pending ? "Ending demo…" : "End demo & reset"}
    </button>
    {error && <span id={errorId} role="alert" className="mt-1 max-w-xs text-[11px] leading-relaxed">{error}</span>}
  </span>;
}
