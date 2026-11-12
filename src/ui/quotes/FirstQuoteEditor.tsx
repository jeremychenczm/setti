"use client";

import { EyeOff, LoaderCircle, MessageCircle, Plus, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { QuoteView } from "@/opening/types";
import type { PricingChangeInput } from "@/pricing/types";
import { RECEIPT_FORMAT, RECEIPT_NOT_INCLUDED, type VersionReceipt } from "@/receipts/types";
import { calculateLineTotals } from "@/quotes/totals";
import type { QuoteLine } from "@/quotes/types";
import { BrandMark } from "../BrandMark";
import { ChangeDrawer } from "../pricing/ChangeDrawer";
import { shortMoney } from "../pricing/common";
import { QuotePreview } from "../pricing/QuotePreview";
import { FirstTotalCard } from "../pricing/TotalCard";
import { EditorCrumbs, EditorLayout, GHOST, ItemsCard, PreviewButton, ProjectInfoCard, SELECT, SEND, SendBar, SumRow, TOOL } from "../pricing/EditorFrame";
import { INTERNAL_COLUMNS, QuoteItemsGrid, type EditableGridField, type ItemsColumns, type ItemsView } from "../pricing/QuoteItemsGrid";

/** A line as the form holds it: amounts as typed, in dollars. */
interface FormLine {
  key: string; itemId?: string;
  name: string; category: "furniture" | "service"; vendor: string; room: string; sku: string; specification: string;
  quantity: string; unitLabel: string; unitPrice: string; tax: string; delivery: string;
  leadTimeDays: string; returnPolicy: string; restockingFee: string; customMade: boolean; returnable: "unknown" | "yes" | "no"; sourceUrl: string;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
/** Cents from a typed dollar amount, or null when it is not one. */
function cents(value: string): number | null {
  const text = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}
const whole = (value: string) => /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
let fresh = 0;

function toForm(line: QuoteLine): FormLine {
  return {
    key: line.itemId, itemId: line.itemId, name: line.name, category: line.category, vendor: line.vendor, room: line.room, sku: line.sku, specification: line.specification,
    quantity: String(line.quantity), unitLabel: line.unitLabel ?? "", unitPrice: dollars(line.unitPriceCents), tax: dollars(line.taxCents), delivery: dollars(line.freightCents),
    leadTimeDays: line.leadTimeDays === null ? "" : String(line.leadTimeDays), returnPolicy: line.returnPolicy,
    restockingFee: line.restockingFeeBps === null ? "" : String(line.restockingFeeBps / 100), customMade: line.customMade,
    returnable: line.nonReturnable === null ? "unknown" : line.nonReturnable ? "no" : "yes", sourceUrl: line.source.url ?? "",
  };
}

const blank = (room: string, category: FormLine["category"] = "furniture"): FormLine => ({
  key: `new-${++fresh}`, name: "", category, vendor: "", room, sku: "", specification: "", quantity: "1", unitLabel: "", unitPrice: "", tax: "0.00", delivery: "0.00",
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

/** The grid reads a first quote's lines as items the designer adds. */
function asChange(line: FormLine): PricingChangeInput {
  return {
    key: line.key, action: "add", itemId: null, priceEvidence: "", confirmed: true, oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemFees: [], oldItemNote: "",
    after: {
      name: line.name || "New item", vendor: line.vendor, brand: null, sku: line.sku, specification: line.specification, category: line.category, room: line.room,
      quantity: whole(line.quantity) ?? 1, unitLabel: line.unitLabel || "each", currency: "USD", unitPriceCents: cents(line.unitPrice), taxCents: cents(line.tax), freightCents: cents(line.delivery),
      sourceUrl: line.sourceUrl || null, returnPolicy: line.returnPolicy, returnable: line.returnable === "unknown" ? null : line.returnable === "yes", restockingFeeBps: null, customMade: line.customMade, leadTimeDays: null,
    },
  };
}

/** The first quote as the client would receive it, for Preview. */
function draftReceipt(view: QuoteView, room: string, clientName: string, lines: FormLine[]): VersionReceipt {
  const totalCents = lines.reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0);
  return {
    format: RECEIPT_FORMAT, receiptNo: `${view.projectKey.toUpperCase()}-V1-DRAFT`, issuedAt: new Date().toISOString(),
    project: { key: view.projectKey, name: view.document.projectName, room: room || view.document.room, client: clientName || view.document.clientName, designer: view.document.designerName.replace(/\s*\(demo designer\)$/, "") },
    version: { number: 1, basedOn: null, status: "draft", replacedBy: null, sentAt: null, sentBy: null, contentHash: null, document: view.document, revision: null },
    signatures: [],
    agreement: { kind: "opening", lines: lines.map((line) => ({ itemId: line.key, name: line.name || "New item", vendor: line.vendor, sku: line.sku, quantity: whole(line.quantity) ?? 1, unitLabel: line.unitLabel || "each", totalCents: lineTotal(line) ?? 0, decision: "pending", note: null, decidedAt: null, decidedBy: null, signingId: null })) },
    totals: { previousCents: null, totalCents, differenceCents: null },
    payments: [], pending: null, notIncluded: RECEIPT_NOT_INCLUDED,
  };
}

const FIELD = "mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--primary)]";
const LABEL = "block text-[11px] font-medium text-slate-600";

/**
 * The designer writes quote V1 in the same editor as every later version: the
 * project's details, then each line, item or service, in the grid. The whole
 * draft is saved at once; the server checks it and refuses a save over a draft
 * changed elsewhere. It is sent from the project chat.
 */
export function FirstQuoteEditor({ projectKey, view, studioName = "", onSaved, onOpenChat }: { projectKey: CaseKey; view: QuoteView; studioName?: string; onSaved: () => Promise<void>; onOpenChat: () => void }) {
  const [room, setRoom] = useState(view.document.room);
  const [clientName, setClientName] = useState(view.document.clientName);
  const [lines, setLines] = useState<FormLine[]>(() => view.document.lines.map(toForm));
  const [basedOn, setBasedOn] = useState(view.draftHash ?? "");
  const [editing, setEditing] = useState<FormLine | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const [viewBy, setViewBy] = useState<ItemsView>("section");
  const [columnsShown, setColumnsShown] = useState<ItemsColumns>({ type: true, supplier: true, sku: false, source: false });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  // Naming a new section, or renaming one: `from` is the section being renamed.
  const [section, setSection] = useState<{ from: string | null; name: string } | null>(null);
  const totals = useMemo(() => ({
    products: lines.filter((line) => line.category === "furniture").reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0),
    services: lines.filter((line) => line.category === "service").reduce((sum, line) => sum + (lineTotal(line) ?? 0), 0),
  }), [lines]);

  // Undo and redo step through the designer's edits on this page.
  type Snapshot = { lines: FormLine[]; clientName: string; room: string };
  const steps = useRef<{ past: Snapshot[]; future: Snapshot[]; last: Snapshot; replaying: boolean }>({ past: [], future: [], last: { lines, clientName, room }, replaying: false });
  const [history, setHistory] = useState({ past: 0, future: 0 });
  useEffect(() => {
    const record = steps.current;
    const now = { lines, clientName, room };
    if (record.replaying) record.replaying = false;
    else if (record.last.lines !== lines || record.last.clientName !== clientName || record.last.room !== room) { record.past.push(record.last); record.future = []; }
    record.last = now;
    setHistory({ past: record.past.length, future: record.future.length });
  }, [lines, clientName, room]);
  function replay(from: "past" | "future") {
    const record = steps.current;
    const target = record[from].pop();
    if (!target) return;
    record[from === "past" ? "future" : "past"].push(record.last);
    record.replaying = true;
    setLines(target.lines); setClientName(target.clientName); setRoom(target.room); setDirty(true);
  }
  const undo = () => replay("past");
  const redo = () => replay("future");

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const index = editing ? lines.findIndex((line) => line.key === editing.key) : -1;
  function open(key: string) { const line = lines.find((entry) => entry.key === key); if (line) { setEditing({ ...line }); setLineError(null); } }
  // A new line goes into the last section used, until the designer picks another.
  function add(into?: string) { setEditing(blank(into ?? lines.at(-1)?.room ?? "")); setLineError(null); }
  function saveSection() {
    if (!section) return;
    const name = section.name.trim();
    if (!name) return;
    if (section.from === null) add(name);
    else { const from = section.from; setLines((current) => current.map((line) => line.room.trim() === from ? { ...line, room: name } : line)); setDirty(true); }
    setSection(null);
  }
  /** Keeps the open line, if it is valid, and returns the lines with it. */
  function commit(): FormLine[] | null {
    if (!editing) return lines;
    const wrong = problem(editing);
    if (wrong) { setLineError(wrong); return null; }
    const next = index >= 0 ? lines.map((line) => line.key === editing.key ? editing : line) : [...lines, editing];
    setLines(next); setDirty(true);
    return next;
  }
  function keep() { if (commit()) setEditing(null); }
  /** Moving to another line keeps this one first. */
  function step(by: number) { const next = commit(); const target = next?.[Math.max(0, (index >= 0 ? index : lines.length) + by)]; if (next && target) { setEditing({ ...target }); setLineError(null); } }
  /** Moves a line before or after another; dropped into another section, it joins that section. */
  function move(key: string, target: string, place: "before" | "after") {
    setLines((current) => {
      const moving = current.find((line) => line.key === key), anchor = current.find((line) => line.key === target);
      if (!moving || !anchor || key === target) return current;
      const rest = current.filter((line) => line.key !== key);
      const at = rest.indexOf(anchor) + (place === "after" ? 1 : 0);
      const moved = viewBy === "section" ? { ...moving, room: anchor.room } : moving;
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
    setDirty(true);
  }
  function remove(key: string) { setLines((current) => current.filter((line) => line.key !== key)); setDirty(true); setEditing(null); }
  function editCell(key: string, field: EditableGridField, value: string) {
    setLines((current) => current.map((line) => line.key !== key ? line : field === "quantity" ? { ...line, quantity: value.trim() } : field === "unitPriceCents" ? { ...line, unitPrice: value.trim() } : line));
    setDirty(true);
  }

  async function save() {
    const wrong = lines.map(problem).findIndex(Boolean);
    if (wrong >= 0) { setError(`${lines[wrong].name || `Line ${wrong + 1}`}: ${problem(lines[wrong])}`); return; }
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

  const set = <K extends keyof FormLine>(key: K) => (value: FormLine[K]) => setEditing((line) => line ? { ...line, [key]: value } : line);
  const changes = lines.map(asChange);
  const designer = view.document.designerName.replace(/\s*\(demo designer\)$/, "");
  const created = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
  const total = totals.products + totals.services;
  return <section className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl text-[12.5px] text-[var(--ink)]" aria-label="Quote editor">
    <EditorLayout
      main={<>
        <EditorCrumbs name={view.document.projectName} right={<span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-2.5 py-[5px] text-[12px] text-[var(--muted)]">Version <b className="font-semibold text-[var(--ink)]">V1 · Draft</b></span>} />
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</p>}

        <ProjectInfoCard open={infoOpen} onToggle={() => setInfoOpen((value) => !value)} summary={`${view.document.projectName} · ${clientName || "No client yet"} · Quote V1 · Draft`}
          studio={{ name: studioName || designer, person: `${designer} · Designer`, note: "Studio details from Settings" }}
          client={<><input aria-label="Client name" value={clientName} maxLength={120} onChange={(event) => { setClientName(event.target.value); setDirty(true); }} placeholder="The client's full name" className="-mx-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-[13.5px] font-bold outline-none hover:border-[var(--line)] focus:border-[#cfcab9]" />
            <input aria-label="Scope or rooms" value={room} maxLength={120} onChange={(event) => { setRoom(event.target.value); setDirty(true); }} placeholder="Scope or rooms, for example Kitchen and dining" className="-mx-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-[12.5px] outline-none hover:border-[var(--line)] focus:border-[#cfcab9]" />
            <span className="text-[12.5px] text-[var(--muted)]">Signs in the project chat</span></>}
          title={view.document.projectName}
          meta={[{ label: "Created", value: created }, { label: "Currency", value: "USD" }]}
          quote={{ version: 1, status: "Draft", note: dirty ? "Only you can see this draft. Unsaved edits." : "Only you can see this draft." }} />

        <ItemsCard open={itemsOpen} onToggle={() => setItemsOpen((value) => !value)} summary={`${lines.length} items · V1 total ${shortMoney(total)}`}
          tools={<>
            <button type="button" onClick={() => setSection({ from: null, name: "" })} className={TOOL}><Plus className="h-[15px] w-[15px]" />Add section</button>
            <button type="button" onClick={() => add()} className={TOOL}><Plus className="h-[15px] w-[15px]" />Add item</button>
            <button type="button" onClick={onOpenChat} className={`${TOOL} text-[var(--primary)]`}><BrandMark className="h-[15px] w-[15px]" />Ask Setti to draft the quote</button>
            <button type="button" onClick={undo} disabled={saving || !history.past} aria-label="Undo" title="Undo" className={TOOL}><Undo2 className="h-[15px] w-[15px]" /></button>
            <button type="button" onClick={redo} disabled={saving || !history.future} aria-label="Redo" title="Redo" className={TOOL}><Redo2 className="h-[15px] w-[15px]" /></button>
            <span className="flex-1" />
            <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted)]">View by<select aria-label="View by" value={viewBy} onChange={(event) => setViewBy(event.target.value as ItemsView)} className={SELECT}><option value="section">Section</option><option value="supplier">Supplier</option></select></label>
            <span className="relative">
              <button type="button" onClick={() => setColumnsOpen((value) => !value)} aria-expanded={columnsOpen} className={GHOST}>Columns</button>
              {columnsOpen && <div role="dialog" aria-label="Columns" className="absolute right-0 top-[calc(100%+6px)] z-20 grid w-56 gap-0.5 rounded-[10px] border border-[var(--line)] bg-white p-2 shadow-lg">
                {INTERNAL_COLUMNS.filter((column) => column.key !== "source").map((column) => <label key={column.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-[5px] text-[12px] hover:bg-[var(--canvas)]"><input type="checkbox" checked={columnsShown[column.key]} onChange={(event) => setColumnsShown((shown) => ({ ...shown, [column.key]: event.target.checked }))} /><span className="flex-1">{column.label}</span><EyeOff className="h-3.5 w-3.5 text-[var(--muted)]" aria-label="Hidden from the client" /></label>)}
                <p className="mt-1 border-t border-[var(--line)] px-1.5 pt-1 text-[11px] text-[var(--muted)]">Columns with <EyeOff className="inline h-3 w-3" /> never appear on the quote the client receives.</p>
              </div>}
            </span>
            <PreviewButton onClick={() => { setColumnsOpen(false); setPreviewing(true); }} disabled={!lines.length} />
          </>}>
          {lines.length
            ? <QuoteItemsGrid first changes={changes} baselineLines={[]} issues={[]} raw={{}} disabled={saving} drafted={false} view={viewBy} columns={columnsShown} selectedKey={editing?.key ?? null} onSelect={open} onEdit={editCell} onCheck={() => undefined} onResolve={() => undefined} onRenameGroup={(name) => setSection({ from: name, name })} onAddItem={(name) => add(name)} onMove={move} />
            : <div className="grid justify-items-center gap-2.5 px-4 pb-[38px] pt-[34px] text-center"><h4 className="text-[15px] font-bold">This quote has no items yet</h4><p className="max-w-[52ch] text-[var(--muted)]">Add the items and services the client will decide on, or ask Setti to draft them from the project chat. Nothing reaches the client until you send it.</p>
              <div className="flex flex-wrap justify-center gap-2"><button type="button" onClick={() => setSection({ from: null, name: "" })} className={GHOST}><Plus className="h-3.5 w-3.5" />Add section</button><button type="button" onClick={() => add()} className={GHOST}><Plus className="h-3.5 w-3.5" />Add item</button><button type="button" onClick={onOpenChat} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-[7px] text-[12px] font-semibold text-white"><MessageCircle className="h-3.5 w-3.5" />Ask Setti to draft from the chat</button></div></div>}
        </ItemsCard>
      </>}
      side={lines.length > 0 && <SumRow>
        <span aria-hidden className="hidden sm:block @min-[1472px]:hidden" />
        <FirstTotalCard productCents={totals.products} serviceCents={totals.services} />
      </SumRow>}
      bar={<SendBar>
        <span className="flex-1 text-[12px] text-[#4b5348]">{lines.length} {lines.length === 1 ? "item" : "items"} · Send V1 from the project chat once it is saved; it is frozen when sent.</span>
        <span className="text-[11.5px] text-[var(--muted)]">{dirty ? "Unsaved edits" : "Saved"}</span>
        <button type="button" onClick={() => void save()} disabled={saving || !dirty} className={dirty ? SEND : GHOST}>{saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save</button>
        <button type="button" onClick={onOpenChat} disabled={dirty} className={SEND}><MessageCircle className="h-[15px] w-[15px]" />Send from the chat</button>
      </SendBar>} />

    {editing && <ChangeDrawer index={index >= 0 ? index : lines.length} count={index >= 0 ? lines.length : lines.length + 1} action={index >= 0 ? "quantity" : "add"} title={editing.name || "New item"} subtitle={[editing.vendor, editing.sku].filter(Boolean).join(" · ") || undefined}
      eyebrow={index >= 0 ? `Item ${index + 1} of ${lines.length}` : "New item"} onDone={keep}
      onPrevious={() => step(-1)} onNext={() => step(1)} onClose={() => setEditing(null)}
      footer={<div className="flex flex-wrap items-center gap-2">{lineError && <p role="alert" className="w-full text-[11.5px] text-red-700">{lineError}</p>}
        {index >= 0 && <button type="button" onClick={() => remove(editing.key)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-[12px] font-semibold text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" />Remove item</button>}
        <button type="button" onClick={keep} className="ml-auto rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-semibold text-white">{index >= 0 ? "Keep changes" : "Add to the quote"}</button></div>}>
      <div className="space-y-3">
        <label className={LABEL}>Name<input value={editing.name} maxLength={160} onChange={(event) => set("name")(event.target.value)} className={FIELD} autoFocus /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Type<select value={editing.category} onChange={(event) => set("category")(event.target.value as FormLine["category"])} className={FIELD}><option value="furniture">Product</option><option value="service">Service</option></select></label>
          <label className={LABEL}>Section<input value={editing.room} maxLength={120} onChange={(event) => set("room")(event.target.value)} placeholder="Kitchen, Lighting…" className={FIELD} /></label>
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
          <label className="flex items-end gap-2 pb-1.5 text-[12px] text-slate-600"><input type="checkbox" checked={editing.customMade} onChange={(event) => set("customMade")(event.target.checked)} />Made to order</label>
        </div>
        <label className={LABEL}>Supplier link<input value={editing.sourceUrl} maxLength={2000} placeholder="https://" onChange={(event) => set("sourceUrl")(event.target.value)} className={FIELD} /></label>
      </div>
    </ChangeDrawer>}
    {previewing && <QuotePreview receipt={draftReceipt(view, room, clientName, lines)} onClose={() => setPreviewing(false)} />}
    {section && <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(36,38,32,0.45)] p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setSection(null); }}>
      <form role="dialog" aria-modal="true" aria-labelledby="section-title" onSubmit={(event) => { event.preventDefault(); saveSection(); }} className="grid w-full max-w-[400px] gap-3 rounded-2xl bg-white p-5 shadow-2xl">
        <h2 id="section-title" className="text-[15px] font-bold">{section.from === null ? "Add section" : `Rename ${section.from}`}</h2>
        <p className="-mt-1.5 text-[12px] text-[var(--muted)]">{section.from === null ? "Group the quote the way the client thinks about it, for example by room or trade. Its first item opens next." : "Every item in this section moves with the new name."}</p>
        <label className={LABEL}>Section name<input value={section.name} autoFocus maxLength={120} onChange={(event) => setSection({ ...section, name: event.target.value })} placeholder="Kitchen, Lighting, Trade work…" className={FIELD} /></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setSection(null)} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-[var(--canvas)]">Cancel</button><button type="submit" disabled={!section.name.trim()} className="rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-semibold text-white disabled:bg-slate-200 disabled:text-slate-400">{section.from === null ? "Add section" : "Rename"}</button></div>
      </form>
    </div>}
  </section>;
}
