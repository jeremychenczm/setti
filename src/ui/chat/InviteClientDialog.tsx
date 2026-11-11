"use client";
/** A designer makes the link that brings the project's client in, and copies it to send themselves. */
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useState } from "react";

export function InviteClientDialog({ projectKey, projectName, onClose }: { projectKey: string; projectName: string; onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function makeLink() {
    setBusy(true); setError(null); setCopied(false);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/invite`, { method: "POST" });
      const body = await response.json().catch(() => null) as { path?: string; expiresAt?: string; error?: string } | null;
      if (!response.ok || !body?.path || !body.expiresAt) setError(body?.error ?? "The link could not be made. Try again.");
      else setLink({ url: `${window.location.origin}${body.path}`, expiresAt: body.expiresAt });
    } catch {
      setError("The link could not be made. Check the connection and try again.");
    }
    setBusy(false);
  }

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); }
    catch { setError("Copying was blocked. Select the link and copy it yourself."); }
  }

  const until = link && new Date(link.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return <div role="dialog" aria-modal="true" aria-labelledby="invite-client-title" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 px-4">
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 id="invite-client-title" className="text-[16px] font-semibold">Invite the client</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-slate-600">Send your client a link to {projectName}. They create an account or sign in, then see the quote and this chat.</p>
      {link ? <>
        <div className="mt-4 flex gap-2">
          <input readOnly value={link.url} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--canvas)] px-3 py-2 text-[12px] outline-none" />
          <button type="button" onClick={() => void copy()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">Works once, until {until}. Setti does not email it: send it yourself.</p>
      </> : <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">A link works once and for 7 days. Making a new link turns off any earlier one.</p>}
      {error && <p role="alert" className="mt-3 text-[12px] text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        {link ? <>
          <button type="button" onClick={() => void makeLink()} disabled={busy} className="rounded-lg px-3 py-2 text-[12px] font-medium text-slate-600 hover:bg-[var(--canvas)]">Make a new link</button>
          <button type="button" onClick={onClose} className="rounded-lg bg-[var(--primary-soft)] px-4 py-2 text-[12px] font-semibold text-[var(--primary)] hover:bg-brand-100">Done</button>
        </> : <>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12px] font-medium text-slate-600 hover:bg-[var(--canvas)]">Cancel</button>
          <button type="button" onClick={() => void makeLink()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Make invite link</button>
        </>}
      </div>
    </div>
  </div>;
}
