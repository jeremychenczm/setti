"use client";
/** A designer names a new project; the studio's chat for it opens once it is created. */
import { LoaderCircle, X } from "lucide-react";
import { useState, type FormEvent } from "react";

const FIELD = "mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]";

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    // The form sets noValidate: the browser's own message would follow its language, not the app's.
    if (!name) { setError("Name the project."); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, subtitle: String(form.get("subtitle") ?? "") }),
      });
      const body = await response.json().catch(() => null) as { href?: string; error?: string } | null;
      if (!response.ok || !body?.href) { setError(body?.error ?? "The project could not be created. Try again."); setBusy(false); return; }
      window.location.assign(body.href);
    } catch {
      setError("The project could not be created. Check the connection and try again.");
      setBusy(false);
    }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="new-project-title" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 px-4">
    <form onSubmit={(event) => void submit(event)} noValidate className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 id="new-project-title" className="text-[16px] font-semibold">New project</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button>
      </div>
      <label className="mt-4 block text-[12px] font-medium">Project name<input name="name" required maxLength={80} autoFocus autoComplete="off" className={FIELD} /></label>
      <label className="mt-3 block text-[12px] font-medium">Scope <span className="font-normal text-[var(--muted)]">(optional)</span><input name="subtitle" maxLength={120} autoComplete="off" placeholder="Kitchen and dining" className={FIELD} /></label>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">The project starts with an empty quote V1. You add its lines before sending it to the client.</p>
      {error && <p role="alert" className="mt-3 text-[12px] text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12px] font-medium text-slate-600 hover:bg-[var(--canvas)]">Cancel</button>
        <button disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Create project</button>
      </div>
    </form>
  </div>;
}
