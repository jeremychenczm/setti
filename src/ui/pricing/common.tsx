"use client";

import { themeQuartz } from "ag-grid-community";
import { useEffect, useState, type ReactNode } from "react";
import type { FromV1 } from "@/chat/types";
import type { FieldChange } from "@/pricing/review-diff";

export const pricingTheme = themeQuartz.withParams({ accentColor: "#b27a26", backgroundColor: "#ffffff", foregroundColor: "#30362d", borderColor: "#e7e5db", headerBackgroundColor: "#f7f6f2", fontFamily: "inherit", fontSize: 12, headerFontSize: 11, wrapperBorder: false });
export const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-800 outline-none focus:border-brand-400 disabled:bg-slate-50 disabled:text-slate-400";

export function money(value: number | null): string {
  return value === null ? "Not yet priced" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

export function signedMoney(value: number | null): string {
  return value === null ? "Not yet priced" : `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

export function centsText(value: number | null): string {
  return value === null ? "" : (value / 100).toFixed(2);
}

/** Decimal dollars are parsed as digits, never rounded or silently truncated. */
export function parseDollars(value: string): { value: number | null; error: string | null } {
  if (!value.trim()) return { value: null, error: null };
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return { value: null, error: "Enter a non-negative USD amount with at most two decimal places." };
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? { value: cents, error: null } : { value: null, error: "This amount is too large." };
}

export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-[11px] font-medium text-slate-600">{label}</span>{children}{hint && <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">{hint}</span>}{error && <span role="alert" className="mt-1 block text-[10px] text-red-600">{error}</span>}</label>;
}

export function TotalTile({ label, amount, signed = false }: { label: string; amount: number | null; signed?: boolean }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] text-slate-500">{label}</div><div className="mt-1.5 text-[23px] font-semibold tabular-nums">{signed ? signedMoney(amount) : money(amount)}</div></div>;
}

export function dateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" });
}

export function LocalShareLink({ path }: { path: string }) {
  const [origin, setOrigin] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const url = `${origin}${path}`;
  async function copy() {
    try { await navigator.clipboard.writeText(url); setFeedback("Link copied."); }
    catch { setFeedback("Select and copy the complete link below."); }
  }
  return <div className="mt-3"><div className="flex gap-2"><input aria-label="Local read-only client link" readOnly value={url} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 rounded-lg border border-emerald-100 bg-white px-3 py-2 font-mono text-[10px] text-emerald-900" /><button onClick={() => void copy()} className="shrink-0 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-[11px] font-medium text-emerald-900 hover:bg-emerald-50">Copy link</button></div>{feedback && <p role="status" className="mt-1 text-[10px] text-emerald-800">{feedback}</p>}</div>;
}

/**
 * Where a line of a new version came from in quote V1. With `changes`, a carried
 * line says whether it still matches V1, and `listChanges` spells the changes out.
 */
export function FromV1Note({ fromV1, changes, listChanges = false, className = "" }: { fromV1: FromV1 | undefined; changes?: FieldChange[]; listChanges?: boolean; className?: string }) {
  if (!fromV1) return null;
  const carried = changes === undefined ? "Carried over from quote V1" : changes.length ? "Carried over from quote V1, with changes" : "Carried over from quote V1, unchanged";
  return <div className={`rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 ${className}`}>
    <p>{fromV1.kind === "revised"
      ? <>Revised from quote V1 · the client declined it{fromV1.reason ? <>: &ldquo;{fromV1.reason}&rdquo;</> : "."}</>
      : `${carried} · the client has not decided on it yet.`}</p>
    {listChanges && changes && changes.length > 0 && <ul className="mt-1 space-y-0.5">{changes.map((change) => <li key={change.label}>{change.label}: <span className="line-through decoration-amber-400">{change.before}</span> → <strong className="font-medium">{change.after}</strong></li>)}</ul>}
  </div>;
}
