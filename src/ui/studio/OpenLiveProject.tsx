"use client";

import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { HOME_SCENARIO } from "@/demo/living-dining";
import { canOpenPreparedWorkspace, useTryPreparation, type PreparationSeed } from "../try/TryPreparationProvider";
import { switchPersona } from "../account/switchPersona";

/** Only this explicit action opens/creates the real walkthrough; browsing examples is local. */
export function OpenLiveProject({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const { seed } = useTryPreparation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const saved = seed?.scenario === HOME_SCENARIO && canOpenPreparedWorkspace(seed);

  async function open() {
    if (working.current) return;
    working.current = true; setPending(true); setError(null);
    try {
      if (!saved) {
        const response = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", scenario: HOME_SCENARIO }), signal: AbortSignal.timeout(20_000) });
        const result = await response.json().catch(() => null) as { error?: string; seed?: PreparationSeed } | null;
        if (!response.ok) throw new Error(result?.error ?? "The live project could not be opened. Your saved records are kept.");
        if (!result?.seed || result.seed.scenario !== HOME_SCENARIO || !canOpenPreparedWorkspace(result.seed)) throw new Error("Your earlier walkthrough still needs preparation. Open Demo home to continue its saved setup.");
      }
      // The project opens fresh as the designer, rather than a prefetched page rendered for the client.
      const problem = await switchPersona("jordan", "/chats/maple");
      if (problem) throw new Error(problem);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The live project could not be opened.");
      setPending(false); working.current = false;
    }
  }

  return <span className="inline-flex flex-col items-start gap-2">
    <button type="button" className={className} disabled={pending} onClick={() => void open()}>
      {pending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {pending ? "Opening project…" : compact ? "Open live walkthrough" : saved ? "Continue your live project" : "Start the live walkthrough"}
      {!pending && <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
    </button>
    {error && <span role="alert" className="max-w-sm text-[12px] leading-6 text-red-800">{error}</span>}
  </span>;
}
