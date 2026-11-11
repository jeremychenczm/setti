"use client";
/**
 * The designer writes quote V1 before sending it: the project's details and each
 * line, item or service. The whole draft is saved at once; the server checks it
 * and refuses a save over a draft changed elsewhere.
 */
import { ArrowLeft, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { QuoteView } from "@/opening/types";
import { calculateLineTotals } from "@/quotes/totals";
import type { QuoteLine } from "@/quotes/types";

/** A line as the form holds it: amounts as typed, in dollars. */
interface FormLine {
  itemId?: string;
  name: string; category: "furniture" | "service"; vendor: string; room: string; sku: string; specification: string;
  quantity: string; unitLabel: string; unitPrice: string; tax: string; delivery: string;
  leadTimeDays: string; returnPolicy: string; restockingFee: string; customMade: boolean; returnable: "unknown" | "yes" | "no"; sourceUrl: string;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Cents from a typed dollar amount, or null when it is not one. */
function cents(value: string): number | null {
  const text = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}
const whole = (value: string) => /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;

function toForm(line: QuoteLine): FormLine {
  return {
    itemId: line.itemId, name: line.name, category: line.category, vendor: line.vendor, room: line.room, sku: line.sku, specification: line.specification,
    quantity: String(line.quantity), unitLabel: line.unitLabel ?? "", unitPrice: dollars(line.unitPriceCents), tax: dollars(line.taxCents), delivery: dollars(line.freightCents),
    leadTimeDays: line.leadTimeDays === null ? "" : String(line.leadTimeDays), returnPolicy: line.returnPolicy,
    restockingFee: line.restockingFeeBps === null ? "" : String(line.restockingFeeBps / 100), customMade: line.customMade,
    returnable: line.nonReturnable === null ? "unknown" : line.nonReturnable ? "no" : "yes", sourceUrl: line.source.url ?? "",
  };
}

const blank = (room: string): FormLine => ({
  name: "", category: "furniture", vendor: "", room, sku: "", specification: "", quantity: "1", unitLabel: "", unitPrice: "", tax: "0.00", delivery: "0.00",
  leadTimeDays: "", returnPolicy: "", restockingFee: "", customMade: false, returnable: "unknown", sourceUrl: "",
});

/** What is wrong with the line as typed, or null. The server checks it again. */
function problem(line: FormLine): string | null {
  if (!line.name.trim()) return "Name the item or service.";
  if (!whole(line.quantity) || whole(line.quantity)! < 1) return "The quantity is a whole number, at least 1.";
  for (const [label, value] of [["unit price", line.unitPrice], ["tax", line.tax], ["delivery", line.delivery]] as const) if (cents(value) === null) return `Enter the ${label} in dollars, for example 125.00.`;
  if (line.leadTimeDays.trim() && whole(line.leadTimeDays) === null) return "The lead time is a whole number of days, or leave it empty.";
  if (line.restockingFee.trim()) { const fee = Number(line.restockingFee); if (!(fee >= 0 && fee <= 100)) return "The restocking fee is a percentage from 0 to 100, or leave it empty."; }
  if (line.sourceUrl.trim() && !/^https?:\/\/\S+$/.test(line.sourceUrl.trim())) return "The supplier link starts with http:// or https://.";
  return null;
}

function payload(line: FormLine) {
  return {
    ...(line.itemId ? { itemId: line.itemId } : {}),
    name: line.name.trim(), category: line.category, vendor: line.vendor.trim(), room: line.room.trim(), sku: line.sku.trim(), specification: line.specification.trim(),
    quantity: whole(line.quantity)!, unitLabel: line.unitLabel.trim(), unitPriceCents: cents(line.unitPrice)!, taxCents: cents(line.tax)!, freightCents: cents(line.delivery)!,
    leadTimeDays: line.leadTimeDays.trim() ? whole(line.leadTimeDays)! : null, returnPolicy: line.returnPolicy.trim(),
    restockingFeeBps: line.restockingFee.trim() ? Math.round(Number(line.restockingFee) * 100) : null,
    customMade: line.customMade, nonReturnable: line.returnable === "unknown" ? null : line.returnable === "no", sourceUrl: line.sourceUrl.trim() || null,
  };
}

function lineTotal(line: FormLine): number | null {
  const quantity = whole(line.quantity), unit = cents(line.unitPrice), tax = cents(line.tax), freight = cents(line.delivery);
  return quantity && unit !== null && tax !== null && freight !== null ? calculateLineTotals({ quantity, unitPriceCents: unit, taxCents: tax, freightCents: freight }).totalCents : null;
}

const FIELD = "mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--primary)]";
const LABEL = "block text-[11px] font-medium text-slate-600";

export function QuoteDraftEditor({ projectKey, view, onSaved, onClose }: { projectKey: CaseKey; view: QuoteView; onSaved: () => Promise<void>; onClose: () => void }) {
  const [room, setRoom] = useState(view.document.room);
  const [clientName, setClientName] = useState(view.document.clientName);
  const [lines, setLines] = useState<FormLine[]>(() => view.document.lines.map(toForm));
  const [basedOn, setBasedOn] = useState(view.draftHash ?? "");
  const [open, setOpen] = useState<number | null>(view.document.lines.length ? null : -1);
  const [editing, setEditing] = useState<FormLine>(() => blank(view.document.room));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const total = useMemo(() => lines.reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0), [lines]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function edit(index: number) { setOpen(index); setEditing(index >= 0 ? { ...lines[index] } : blank(room)); setLineError(null); }
  function keep() {
    const wrong = problem(editing);
    if (wrong) { setLineError(wrong); return; }
    setLines((current) => open !== null && open >= 0 ? current.map((line, index) => index === open ? editing : line) : [...current, editing]);
    setOpen(null); setDirty(true);
  }
  function remove(index: number) { setLines((current) => current.filter((_, at) => at !== index)); setDirty(true); if (open === index) setOpen(null); }

  async function save() {
    const wrong = lines.map(problem).findIndex(Boolean);
    if (wrong >= 0) { setError(`Line ${wrong + 1}: ${problem(lines[wrong])}`); return; }
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/quotes/${projectKey}/draft`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ basedOn, room: room.trim(), clientName: clientName.trim(), lines: lines.map(payload) }) });
      const body = await response.json().catch(() => null) as { hash?: string; document?: { lines: QuoteLine[] }; error?: string } | null;
      if (!response.ok || !body?.hash || !body.document) { setError(body?.error ?? "The quote could not be saved. Your edits are still here; try again."); return; }
      setBasedOn(body.hash); setLines(body.document.lines.map(toForm)); setDirty(false);
      await onSaved();
    } catch { setError("The connection was interrupted. Your edits are still here; try again."); }
    finally { setSaving(false); }
  }

  const set = <K extends keyof FormLine>(key: K) => (value: FormLine[K]) => setEditing((line) => ({ ...line, [key]: value }));
  return <section className="flex min-w-0 flex-1 overflow-hidden rounded-xl bg-white shadow-sm">
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-6 py-3.5">
        <button onClick={() => { if (!dirty || window.confirm("Leave without saving your changes to quote V1?")) onClose(); }} className="flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" />Back to the quote</button>
        <span className="text-[var(--line)]">/</span>
        <span className="text-[12px] font-medium">Edit quote V1 · {view.document.projectName}</span>
        <span className="ml-auto text-[12px] text-[var(--muted)]">{dirty ? "Unsaved changes" : "Saved"}</span>
        <button onClick={() => void save()} disabled={saving || !dirty} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:text-slate-400">{saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}Save V1</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[920px] px-5 py-6">
          {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={LABEL}>Scope or rooms<input value={room} maxLength={120} onChange={(event) => { setRoom(event.target.value); setDirty(true); }} placeholder="Kitchen and dining" className={FIELD} /></label>
            <label className={LABEL}>Prepared for<input value={clientName} maxLength={120} onChange={(event) => { setClientName(event.target.value); setDirty(true); }} placeholder="The client's full name" className={FIELD} /></label>
          </div>
          <div className="mt-6 flex items-baseline justify-between"><h2 className="text-[14px] font-semibold">Lines · {lines.length}</h2><span className="text-[13px] font-semibold tabular-nums">{usd(total)}</span></div>
          <ul className="mt-2 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {lines.map((line, index) => <li key={line.itemId ?? `new-${index}`} className={`flex items-center gap-3 py-2.5 ${open === index ? "bg-[var(--primary-soft)]" : ""}`}>
              <button onClick={() => edit(index)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] font-medium">{line.name}</span>
                <span className="block truncate text-[11px] text-[var(--muted)]">{line.category === "service" ? "Service" : "Item"}{line.vendor ? ` · ${line.vendor}` : ""} · {line.quantity} × {cents(line.unitPrice) === null ? line.unitPrice : usd(cents(line.unitPrice)!)}{line.room ? ` · ${line.room}` : ""}</span>
              </button>
              <span className="shrink-0 text-[13px] tabular-nums">{lineTotal(line) === null ? "—" : usd(lineTotal(line)!)}</span>
              <button onClick={() => remove(index)} aria-label={`Remove ${line.name}`} className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-red-50 hover:text-red-700"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>)}
          </ul>
          {!lines.length && <p className="py-6 text-center text-[12px] text-[var(--muted)]">No lines yet. Add the items and services the client will decide on.</p>}
          <button onClick={() => edit(-1)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium text-[var(--primary)] hover:bg-[var(--primary-soft)]"><Plus className="h-3.5 w-3.5" />Add a line</button>
          <p className="mt-6 text-[11px] leading-relaxed text-[var(--muted)]">V1 stays a draft only your studio sees. Send it from the project chat; once sent it is frozen, and later changes go through a new version.</p>
        </div>
      </div>
    </div>
    {open !== null && <aside aria-label={open >= 0 ? "Edit line" : "New line"} className="flex w-full max-w-[380px] shrink-0 flex-col border-l border-[var(--line)] bg-white">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3"><h3 className="text-[13px] font-semibold">{open >= 0 ? "Edit line" : "New line"}</h3><button onClick={() => setOpen(null)} aria-label="Close line form" className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--canvas)]"><X className="h-4 w-4" /></button></div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <label className={LABEL}>Name<input value={editing.name} maxLength={160} onChange={(event) => set("name")(event.target.value)} className={FIELD} autoFocus /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Type<select value={editing.category} onChange={(event) => set("category")(event.target.value as FormLine["category"])} className={FIELD}><option value="furniture">Item</option><option value="service">Service</option></select></label>
          <label className={LABEL}>Room<input value={editing.room} maxLength={120} onChange={(event) => set("room")(event.target.value)} className={FIELD} /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Supplier<input value={editing.vendor} maxLength={120} onChange={(event) => set("vendor")(event.target.value)} className={FIELD} /></label>
          <label className={LABEL}>SKU<input value={editing.sku} maxLength={80} onChange={(event) => set("sku")(event.target.value)} className={FIELD} /></label>
        </div>
        <label className={LABEL}>Description<textarea value={editing.specification} maxLength={2000} rows={3} onChange={(event) => set("specification")(event.target.value)} className={FIELD} /></label>
        <div className="grid grid-cols-3 gap-3">
          <label className={LABEL}>Quantity<input inputMode="numeric" value={editing.quantity} onChange={(event) => set("quantity")(event.target.value)} className={FIELD} /></label>
          <label className={`${LABEL} col-span-2`}>Unit<input value={editing.unitLabel} maxLength={30} placeholder="each, sq ft, hour" onChange={(event) => set("unitLabel")(event.target.value)} className={FIELD} /></label>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className={LABEL}>Unit price ($)<input inputMode="decimal" value={editing.unitPrice} onChange={(event) => set("unitPrice")(event.target.value)} className={FIELD} /></label>
          <label className={LABEL}>Tax ($)<input inputMode="decimal" value={editing.tax} onChange={(event) => set("tax")(event.target.value)} className={FIELD} /></label>
          <label className={LABEL}>Delivery ($)<input inputMode="decimal" value={editing.delivery} onChange={(event) => set("delivery")(event.target.value)} className={FIELD} /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Lead time (days)<input inputMode="numeric" value={editing.leadTimeDays} placeholder="Not known yet" onChange={(event) => set("leadTimeDays")(event.target.value)} className={FIELD} /></label>
          <label className={LABEL}>Restocking fee (%)<input inputMode="decimal" value={editing.restockingFee} placeholder="Not confirmed" onChange={(event) => set("restockingFee")(event.target.value)} className={FIELD} /></label>
        </div>
        <label className={LABEL}>Return terms<textarea value={editing.returnPolicy} maxLength={1000} rows={2} onChange={(event) => set("returnPolicy")(event.target.value)} className={FIELD} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Can it be returned?<select value={editing.returnable} onChange={(event) => set("returnable")(event.target.value as FormLine["returnable"])} className={FIELD}><option value="unknown">Needs review</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          <label className="mt-5 flex items-center gap-2 text-[12px] text-slate-600"><input type="checkbox" checked={editing.customMade} onChange={(event) => set("customMade")(event.target.checked)} />Made to order</label>
        </div>
        <label className={LABEL}>Supplier link<input type="url" value={editing.sourceUrl} maxLength={500} placeholder="https://" onChange={(event) => set("sourceUrl")(event.target.value)} className={FIELD} /></label>
        {lineError && <p role="alert" className="text-[12px] text-red-700">{lineError}</p>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-4 py-3">
        <span className="text-[12px] tabular-nums text-slate-600">{lineTotal(editing) === null ? "" : `Line total ${usd(lineTotal(editing)!)}`}</span>
        <button onClick={keep} className="rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">{open >= 0 ? "Update line" : "Add line"}</button>
      </div>
    </aside>}
  </section>;
}
