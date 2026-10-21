"use client";

import { ArrowLeft, ArrowUpRight, Check, ClipboardCheck, FileText, LoaderCircle, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { CaseKey } from "@/chat/types";
import { previewPricing, requiresOldItemHandling } from "@/pricing/calculation";
import type { OldItemHandling, PricingChangeInput, PricingItem } from "@/pricing/types";
import { calculateLineTotals, calculateQuoteTotals } from "@/quotes/totals";
import { centsText, dateTime, Field, inputClass, LocalShareLink, money, parseDollars, TotalTile } from "./common";
import { fieldKey, PricingGrid, type EditableGridField, type RawFields } from "./PricingGrid";
import { usePricingWorkspace } from "./usePricingWorkspace";
import { changeOrderStatusLabel } from "./changeOrderStatus";

const handlingLabels: Record<OldItemHandling, string> = { pending: "Not checked yet", not_ordered: "Not ordered", cancelled: "Order cancelled", returned: "Returned / return arranged", retained: "Retained in the project", not_applicable: "Not applicable" };
const quantityIdentityFields = new Set<keyof PricingItem>(["name", "vendor", "sku", "specification", "category", "unitLabel"]);

export function PricingWorkspaceView({ projectKey }: { projectKey: CaseKey }) {
  const state = usePricingWorkspace(projectKey);
  const { workspace, input, setInput } = state;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rawByEpoch, setRawByEpoch] = useState<{ epoch: number; values: RawFields; errors: RawFields }>({ epoch: -1, values: {}, errors: {} });
  const raw = rawByEpoch.epoch === state.editorEpoch ? rawByEpoch.values : {};
  const numericErrors = rawByEpoch.epoch === state.editorEpoch ? rawByEpoch.errors : {};
  const hasInvalidNumbers = Object.keys(numericErrors).length > 0;
  const stale = state.sourceStale || state.draftBaselineStale || Boolean(workspace?.stale && !state.adoptedLatest);
  const disabled = Boolean(state.busy || state.loading || stale || state.pendingCheck || state.conflict || !workspace?.sourceDraft);
  const selected = input?.changes.find((change) => change.key === selectedKey) ?? input?.changes[0] ?? null;
  const baselineTotals = useMemo(() => workspace ? calculateQuoteTotals(workspace.quote.lines) : null, [workspace]);
  const preview = useMemo(() => {
    if (!workspace?.sourceDraft || !input || stale || hasInvalidNumbers) return null;
    try { return previewPricing(workspace.quote, workspace.sourceDraft, input); }
    catch { return null; }
  }, [workspace, input, stale, hasInvalidNumbers]);
  const issuedForSavedReview = Boolean(state.lastOrder && workspace?.review && state.lastOrder.order.reviewId === workspace.review.id && state.lastOrder.order.reviewVersion === workspace.review.version);
  const canSave = Boolean(input && workspace?.sourceDraft && !disabled && !hasInvalidNumbers && (!state.saved || state.adoptedLatest));
  const canIssue = Boolean(state.saved && preview?.ready && workspace && !workspace.stale && !disabled && !issuedForSavedReview && !hasInvalidNumbers);

  function patchChange(key: string, patch: Partial<PricingChangeInput>) {
    setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => change.key === key ? { ...change, ...patch } : change) } : previous);
  }

  function patchAfter<K extends keyof PricingItem>(key: string, field: K, value: PricingItem[K]) {
    const previousChange = input?.changes.find((change) => change.key === key);
    if (previousChange?.action === "quantity" && quantityIdentityFields.has(field)) return;
    const previousItem = workspace?.quote.lines.find((line) => line.itemId === previousChange?.itemId);
    if (field === "quantity" && previousChange?.after && requiresOldItemHandling(previousChange, previousItem) !== requiresOldItemHandling({ ...previousChange, after: { ...previousChange.after, [field]: value } }, previousItem)) {
      setRawByEpoch((previous) => {
        if (previous.epoch !== state.editorEpoch) return previous;
        const values = { ...previous.values };
        const errors = { ...previous.errors };
        delete values[fieldKey(key, "oldItemCostCents")];
        delete errors[fieldKey(key, "oldItemCostCents")];
        return { ...previous, values, errors };
      });
    }
    setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => {
      if (change.key !== key || !change.after) return change;
      const before = workspace?.quote.lines.find((line) => line.itemId === change.itemId);
      const updated = { ...change, confirmed: false, after: { ...change.after, [field]: value } };
      const wasRequired = requiresOldItemHandling(change, before);
      const isRequired = requiresOldItemHandling(updated, before);
      if (isRequired && !wasRequired) return { ...updated, oldItemHandling: "pending" as const, oldItemCostCents: null, oldItemNote: "" };
      if (!isRequired && wasRequired) return { ...updated, oldItemHandling: "not_applicable" as const, oldItemCostCents: 0, oldItemNote: "" };
      return updated;
    }) } : previous);
  }

  function setRaw(key: string, field: string, value: string, error: string | null) {
    setRawByEpoch((previous) => {
      const current = previous.epoch === state.editorEpoch ? previous : { epoch: state.editorEpoch, values: {}, errors: {} };
      const errors = { ...current.errors };
      if (error) errors[fieldKey(key, field)] = error; else delete errors[fieldKey(key, field)];
      return { epoch: state.editorEpoch, values: { ...current.values, [fieldKey(key, field)]: value }, errors };
    });
  }

  function editGridField(key: string, field: EditableGridField, value: string) {
    if (disabled) return;
    if (field === "quantity") {
      const quantity = Number(value);
      const valid = /^\d+$/.test(value.trim()) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 10000;
      setRaw(key, field, value, valid ? null : "Enter a whole quantity from 1 to 10,000.");
      if (valid) patchAfter(key, field, quantity); else patchChange(key, { confirmed: false });
    } else if (field === "unitPriceCents" || field === "taxCents" || field === "freightCents") {
      const parsed = parseDollars(value);
      setRaw(key, field, value, parsed.error);
      if (!parsed.error) patchAfter(key, field, parsed.value); else patchChange(key, { confirmed: false });
    } else patchAfter(key, field, value);
  }

  function editOldCost(key: string, value: string) {
    const parsed = parseDollars(value);
    setRaw(key, "oldItemCostCents", value, parsed.error);
    patchChange(key, parsed.error ? { confirmed: false } : { oldItemCostCents: parsed.value, confirmed: false });
  }

  const header = <header className="mb-5 flex flex-wrap items-center gap-3"><a href={`/chats/${projectKey}`} className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-900"><ArrowLeft className="h-3.5 w-3.5" />Back to project chat</a><span className="ml-auto rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Demo designer workspace</span></header>;

  return (
    <div className="min-h-dvh bg-[var(--canvas)] px-3 py-5 text-[var(--ink)] sm:px-6">
      <main className="mx-auto max-w-[1360px]">
        {header}
        <div className="mb-6"><div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500"><ClipboardCheck className="h-4 w-4" />{workspace?.quote.projectName ?? projectKey} · Designer pricing</div><h1 className="text-[26px] font-semibold tracking-tight">Review the change before issuing it</h1><p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-slate-500">Check prices, old-item handling and unresolved details. Save your review, then generate a separate read-only client version. V1 remains unchanged.</p><p className="mt-2 text-[10px] text-slate-400">Demo designer · pricing edits are saved for this demo project and browser.</p></div>

        {state.loading && <div role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading pricing workspace…</div>}
        {state.error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] leading-relaxed text-red-800"><p className="whitespace-pre-wrap">{state.error}</p>{state.pendingCheck && <button onClick={() => void state.checkSavedStatus()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Check saved status</button>}{state.conflict && <button onClick={() => void state.reload()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Load saved review · discard local edits</button>}{!workspace && !state.loading && <button onClick={() => void state.reload()} className="mt-2 font-semibold underline">Try loading again</button>}</div>}
        {state.notice && <div role="status" className="mb-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-[12px] leading-relaxed text-blue-800">{state.notice}</div>}

        {workspace && (!workspace.sourceDraft || stale) && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900">
          <h2 className="font-semibold">{state.draftBaselineStale ? "The original quote behind this AI draft has changed" : workspace.sourceDraft ? state.baselineStale ? "This pricing review uses an older quote snapshot" : "The AI draft has changed" : "There is no current AI draft to price"}</h2>
          <p className="mt-1">{state.draftBaselineStale ? "This draft cannot be repriced against the current original quote. Return to the project chat and ask @AI to prepare a new draft." : workspace.sourceDraft ? "Adopt the latest valid draft and quote explicitly before editing or generating another client version. Existing local pricing edits will be replaced." : "Return to the chat and ask @AI to prepare a change draft. An earlier pricing review cannot be issued after its source draft is withdrawn."}</p>
          {workspace.sourceDraft && !state.draftBaselineStale && <button onClick={state.adoptLatest} disabled={Boolean(state.busy) || state.pendingCheck} className="mt-3 rounded-lg bg-amber-900 px-3 py-2 font-medium text-white disabled:opacity-50">采用最新草稿重新核价</button>}
          {state.draftBaselineStale && <a href={`/chats/${projectKey}`} className="mt-3 inline-block font-semibold underline">Return to chat · ask @AI for a new draft</a>}
        </div>}

        {workspace && input && <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3"><TotalTile label={`Original V${workspace.quote.version} total · USD`} amount={baselineTotals?.totalCents ?? null} /><TotalTile label="Proposed quote total · USD" amount={preview?.proposedTotals?.totalCents ?? null} /><TotalTile label="Quote difference · USD" amount={preview?.deltaTotalCents ?? null} signed /></div>
          <p className="mb-5 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />The quote difference is not the amount to pay now. No approval, authorization, charge or refund happens on this page.</p>

          <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]"><span className={`rounded-full px-2.5 py-1 ${state.saved && !hasInvalidNumbers ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{state.saved && !hasInvalidNumbers ? `Saved review ${workspace.review?.version}` : "Unsaved pricing edits"}</span><span className="text-slate-400">AI draft revision {workspace.sourceDraft?.revision ?? "withdrawn"} · V{workspace.quote.version} is read-only</span>{!state.busy && !state.pendingCheck && <button onClick={() => void state.reload()} className="ml-auto flex items-center gap-1 text-slate-500 hover:underline"><RefreshCw className="h-3 w-3" />Reload saved review · discard local edits</button>}</div>

          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><Field label="Client change-order title"><input aria-label="Client change-order title" className={inputClass} value={input.title} disabled={disabled} onChange={(event) => setInput((previous) => previous ? { ...previous, title: event.target.value } : previous)} /></Field><div className="mt-4"><PricingGrid changes={input.changes} raw={raw} disabled={disabled} selectedKey={selected?.key ?? null} onSelect={setSelectedKey} onEdit={editGridField} /></div></section>

          {selected && <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-[14px] font-semibold">Selected change · edit details</h2><select aria-label="Select change to price" className="max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px]" value={selected.key} onChange={(event) => setSelectedKey(event.target.value)}>{input.changes.map((change, index) => <option key={change.key} value={change.key}>{index + 1}. {change.after?.name || workspace.quote.lines.find((line) => line.itemId === change.itemId)?.name || change.action}</option>)}</select></div>
            <fieldset disabled={disabled} className="min-w-0 space-y-5">{selected.action === "quantity" && <p className="rounded-lg bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-800">This is the original product. Its name, seller, reference, specification, category and purchase unit stay fixed. To choose a different product, return to the chat and ask @AI for a replacement draft.</p>}
              {selected.after && <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Proposed item name"><input aria-label="Proposed item name" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.name} onChange={(event) => patchAfter(selected.key, "name", event.target.value)} /></Field>
                  <Field label="Seller / supplier"><input aria-label="Seller / supplier" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.vendor} onChange={(event) => patchAfter(selected.key, "vendor", event.target.value)} /></Field>
                  <Field label="Brand"><input aria-label="Brand" className={inputClass} value={selected.after.brand ?? ""} onChange={(event) => patchAfter(selected.key, "brand", event.target.value || null)} /></Field>
                  <Field label="SKU / item reference"><input aria-label="SKU / item reference" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.sku} onChange={(event) => patchAfter(selected.key, "sku", event.target.value)} /></Field>
                  <Field label="Room / scope"><input aria-label="Room / scope" className={inputClass} value={selected.after.room} onChange={(event) => patchAfter(selected.key, "room", event.target.value)} /></Field>
                  <Field label="Category"><select aria-label="Category" disabled={selected.action === "quantity"} className={inputClass} value={selected.after.category} onChange={(event) => patchAfter(selected.key, "category", event.target.value === "service" ? "service" : "furniture")}><option value="furniture">Product</option><option value="service">Service</option></select></Field>
                  <Field label="Quantity" error={numericErrors[fieldKey(selected.key, "quantity")]}><input aria-label="Quantity" inputMode="numeric" className={inputClass} value={raw[fieldKey(selected.key, "quantity")] ?? String(selected.after.quantity)} onChange={(event) => editGridField(selected.key, "quantity", event.target.value)} /></Field>
                  <Field label="Purchase unit" hint="For example: each, hour or 2-pack."><input aria-label="Purchase unit" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.unitLabel} onChange={(event) => patchAfter(selected.key, "unitLabel", event.target.value)} /></Field>
                  <Field label="Verified quote currency" hint="Verify the amount before confirming USD; no currency conversion is performed."><select aria-label="Verified quote currency" className={inputClass} value={selected.after.currency ?? ""} onChange={(event) => patchAfter(selected.key, "currency", event.target.value || null)}><option value="">Unconfirmed currency</option><option value="USD">USD · designer verified</option>{selected.after.currency && selected.after.currency !== "USD" && <option value={selected.after.currency}>{selected.after.currency} · must be repriced in USD</option>}</select></Field>
                  {([{ field: "unitPriceCents", label: `Unit price (${selected.after.currency ?? "currency unconfirmed"})` }, { field: "taxCents", label: "Whole-line tax" }, { field: "freightCents", label: "Whole-line delivery" }] as const).map(({ field, label }) => <Field key={field} label={label} hint={field === "unitPriceCents" ? "Price per purchase unit." : "Total for this line. Enter 0 explicitly when checked and not applicable."} error={numericErrors[fieldKey(selected.key, field)]}><input aria-label={label} inputMode="decimal" className={inputClass} placeholder="Unknown" value={raw[fieldKey(selected.key, field)] ?? centsText(selected.after?.[field] ?? null)} onChange={(event) => editGridField(selected.key, field, event.target.value)} /></Field>)}
                </div>
                <div className="grid gap-4 lg:grid-cols-2"><Field label="Specification / selected options"><textarea aria-label="Specification / selected options" readOnly={selected.action === "quantity"} rows={3} className={inputClass} value={selected.after.specification} onChange={(event) => patchAfter(selected.key, "specification", event.target.value)} /></Field><Field label="Price evidence" hint="Record the document, quote, checked date and selected price or option."><textarea aria-label="Price evidence" rows={3} className={inputClass} value={selected.priceEvidence} onChange={(event) => patchChange(selected.key, { priceEvidence: event.target.value, confirmed: false })} /></Field><Field label="Source URL" hint="Optional when the evidence is a supplier document or manual quote."><input aria-label="Source URL" type="url" className={inputClass} value={selected.after.sourceUrl ?? ""} onChange={(event) => patchAfter(selected.key, "sourceUrl", event.target.value || null)} /></Field><Field label="Return / cancellation policy"><textarea aria-label="Return / cancellation policy" rows={3} className={inputClass} value={selected.after.returnPolicy} onChange={(event) => patchAfter(selected.key, "returnPolicy", event.target.value)} /></Field></div>
                <div className="grid gap-4 sm:grid-cols-2"><Field label="Return eligibility"><select aria-label="Return eligibility" className={inputClass} value={selected.after.returnable === null ? "unknown" : selected.after.returnable ? "yes" : "no"} onChange={(event) => patchAfter(selected.key, "returnable", event.target.value === "unknown" ? null : event.target.value === "yes")}><option value="unknown">Not confirmed · see policy</option><option value="yes">Returnable under stated policy</option><option value="no">Not returnable</option></select></Field><label className="flex items-center gap-2 text-[12px] text-slate-600"><input type="checkbox" checked={selected.after.customMade} onChange={(event) => patchAfter(selected.key, "customMade", event.target.checked)} />Custom-made item</label></div>
              </>}

              {requiresOldItemHandling(selected, workspace.quote.lines.find((line) => line.itemId === selected.itemId)) && <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-4"><h3 className="mb-3 text-[12px] font-semibold">Original item · handling and remaining cost</h3>{(() => { const before = workspace.quote.lines.find((line) => line.itemId === selected.itemId); return before ? <p className="mb-3 text-[11px] text-slate-500">V{workspace.quote.version}: {before.quantity} × {before.name} · original whole-line total {money(calculateLineTotals(before).totalCents)} including tax and delivery.</p> : null; })()}<div className="grid gap-4 sm:grid-cols-2"><Field label="Old item handling"><select aria-label="Old item handling" className={inputClass} value={selected.oldItemHandling} onChange={(event) => patchChange(selected.key, { oldItemHandling: event.target.value as OldItemHandling, confirmed: false })}>{(["pending", "not_ordered", "cancelled", "returned", "retained"] as const).map((handling) => <option key={handling} value={handling}>{handlingLabels[handling]}</option>)}</select></Field><Field label="Old-item cost including fees (USD)" hint="Enter the full retained cost or handling charge, including applicable fees. Enter 0 explicitly if verified." error={numericErrors[fieldKey(selected.key, "oldItemCostCents")]}><input aria-label="Old-item cost including fees (USD)" inputMode="decimal" placeholder="Unknown" className={inputClass} value={raw[fieldKey(selected.key, "oldItemCostCents")] ?? centsText(selected.oldItemCostCents)} onChange={(event) => editOldCost(selected.key, event.target.value)} /></Field></div><div className="mt-4"><Field label="Old-item handling note"><textarea aria-label="Old-item handling note" rows={2} className={inputClass} value={selected.oldItemNote} onChange={(event) => patchChange(selected.key, { oldItemNote: event.target.value, confirmed: false })} /></Field></div></div>}
              <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[12px] leading-relaxed"><input aria-label="Designer confirmed this change" type="checkbox" checked={selected.confirmed} onChange={(event) => patchChange(selected.key, { confirmed: event.target.checked })} className="mt-0.5" /><span>I have checked this change, its price, purchase unit and applicable terms. Editing a value clears this check.</span></label>
            </fieldset>
          </section>}

          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><h2 className="mb-4 text-[14px] font-semibold">Resolve the AI draft’s open items</h2><fieldset disabled={disabled} className="space-y-4">{input.issues.length === 0 && <p className="text-[12px] text-slate-500">No open items were supplied by this draft.</p>}{input.issues.map((issue, index) => <div key={issue.id} className="rounded-lg border border-slate-200 p-3"><label className="flex items-start gap-2 text-[12px] leading-relaxed"><input aria-label={`Resolve issue ${index + 1}`} type="checkbox" checked={issue.resolved} onChange={(event) => setInput((previous) => previous ? { ...previous, issues: previous.issues.map((entry) => entry.id === issue.id ? { ...entry, resolved: event.target.checked } : entry) } : previous)} className="mt-0.5" /><span>{issue.label}</span></label><textarea aria-label={`Resolution note ${index + 1}`} rows={2} placeholder="Record how this was checked or resolved." className={`${inputClass} mt-2`} value={issue.note} onChange={(event) => setInput((previous) => previous ? { ...previous, issues: previous.issues.map((entry) => entry.id === issue.id ? { ...entry, note: event.target.value } : entry) } : previous)} /></div>)}</fieldset></section>

          {workspace.sourceDraft?.constraints.length ? <section className="mb-5 rounded-xl border border-blue-100 bg-blue-50 p-4 text-[12px] leading-relaxed text-blue-900"><h2 className="mb-2 font-semibold">Instructions carried into the client version</h2><ul className="list-disc space-y-1 pl-4">{workspace.sourceDraft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></section> : null}
          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><fieldset disabled={disabled} className="grid gap-4 lg:grid-cols-2"><Field label="Client terms" hint="Required. State scope, delivery assumptions, cancellation terms and what this version asks the client to confirm."><textarea aria-label="Client terms" rows={5} className={inputClass} value={input.terms} onChange={(event) => setInput((previous) => previous ? { ...previous, terms: event.target.value, changes: previous.changes.map((change) => ({ ...change, confirmed: false })) } : previous)} /></Field><Field label="Designer review notes" hint="These notes will also be frozen into the read-only client version."><textarea aria-label="Designer review notes" rows={5} className={inputClass} value={input.reviewNotes} onChange={(event) => setInput((previous) => previous ? { ...previous, reviewNotes: event.target.value } : previous)} /></Field></fieldset></section>

          {(hasInvalidNumbers || preview?.problems.length) ? <section role="status" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900"><h2 className="mb-2 font-semibold">Before generating a client version</h2><ul className="list-disc space-y-1 pl-4">{Object.values(numericErrors).map((problem, index) => <li key={`number-${index}`}>{problem}</li>)}{preview?.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></section> : null}

          <div className="sticky bottom-0 z-10 mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur"><span className="mr-auto flex items-center gap-1.5 text-[11px] text-slate-500">{preview?.ready && !hasInvalidNumbers ? <><Check className="h-3.5 w-3.5 text-emerald-600" />Checks complete</> : "Incomplete reviews can be saved. Complete every check before issuing."}</span><button onClick={() => void state.save()} disabled={!canSave} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-[12px] font-medium hover:bg-slate-50 disabled:opacity-40">{state.busy === "save" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save pricing review</button><button onClick={() => void state.issue()} disabled={!canIssue} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-[12px] font-medium text-white hover:bg-blue-600 disabled:bg-slate-200 disabled:text-slate-400">{state.busy === "issue" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}{issuedForSavedReview ? "Client version already generated" : "Generate client change order"}</button></div>
        </>}

        {state.lastOrder && <section className="mb-5 rounded-xl border border-emerald-100 bg-emerald-50 p-5"><h2 className="text-[14px] font-semibold text-emerald-900">Frozen client version · V{state.lastOrder.order.version}</h2><p className="mt-1 text-[12px] leading-relaxed text-emerald-800">{changeOrderStatusLabel(state.lastOrder.status)}. {state.lastOrder.status === "superseded" ? "A newer client version exists. This link remains a historical snapshot." : state.lastOrder.status === "approved" ? "The client's decision is saved against this frozen version. Payment execution is a separate step." : state.lastOrder.status === "declined" ? "Discuss the requested adjustments and prepare a new version." : "The owning demo session can record a client decision. Sharing this link grants read-only access."}</p><a href={`/change-orders/${state.lastOrder.order.id}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 break-all text-[12px] font-semibold text-emerald-900 underline">Open local client review<ArrowUpRight className="h-3.5 w-3.5 shrink-0" /></a><LocalShareLink path={`/change-orders/${state.lastOrder.order.id}`} /><p className="mt-2 text-[10px] text-emerald-700">Local demo link · accessible while this instance is running. No external message was sent.</p></section>}

        {workspace && workspace.orders.length > 0 && <section className="rounded-xl bg-white p-5 shadow-sm"><h2 className="mb-3 text-[14px] font-semibold">Issued version history</h2><ul className="divide-y divide-slate-100">{[...workspace.orders].sort((a, b) => b.version - a.version).map((order) => <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-[12px]"><a href={`/change-orders/${order.id}`} target="_blank" rel="noreferrer" className="font-medium text-[var(--primary)] hover:underline">V{order.version} · {changeOrderStatusLabel(order.status)}</a><span className="text-[10px] text-slate-400">{dateTime(order.issuedAt)}</span><span className="font-medium tabular-nums">{money(order.totalCents)}</span></li>)}</ul></section>}
      </main>
    </div>
  );
}
