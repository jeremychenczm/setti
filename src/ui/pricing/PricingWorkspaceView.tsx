"use client";

import { ArrowLeft, ArrowUpRight, Check, ClipboardCheck, LoaderCircle, RefreshCw, Save, Send, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clientOf } from "@/accounts/demo";
import type { CaseKey } from "@/chat/types";
import { canLoadMapleSampleMaterials, loadMapleSampleMaterials, MAPLE_SAMPLE_MATERIALS } from "@/demo/maple-materials";
import { draftSource, previewPricing, requiresOldItemHandling } from "@/pricing/calculation";
import { NON_REFUNDABLE_FEE_KINDS, NON_REFUNDABLE_FEE_LABEL } from "@/pricing/fees";
import { feeField, OldItemFees } from "./OldItemFees";
import type { NonRefundableFeeKind, OldItemHandling, PricingChangeInput, PricingItem } from "@/pricing/types";
import { calculateLineTotals, calculateQuoteTotals } from "@/quotes/totals";
import { centsText, dateTime, Field, inputClass, LocalShareLink, money, parseDollars, TotalTile, FromV1Note } from "./common";
import { fieldKey, PricingGrid, type EditableGridField, type RawFields } from "./PricingGrid";
import { usePricingWorkspace } from "./usePricingWorkspace";
import { changeOrderStatusLabel } from "./changeOrderStatus";
import { differences } from "@/pricing/review-diff";
import { CarryOverChoices } from "./CarryOverChoices";
import { ChangeDrawer, OPEN_FIRST_CHANGE_EVENT } from "./ChangeDrawer";
import { ChangeSourceFields } from "./ChangeSource";
import { HOME_EVIDENCE_ID, isHomeQuote } from "@/demo/home-evidence";
import { HomeSupplierDocuments } from "../try/HomeSupplierDocuments";
import { useTryReadiness } from "../try/useTryReadiness";

const handlingLabels: Record<OldItemHandling, string> = { pending: "Not checked yet", not_ordered: "Not ordered", cancelled: "Order cancelled", modified: "Modified (re-made or re-sized)", returned: "Returned / return arranged", retained: "Retained in the project", not_applicable: "Not applicable" };
const oldCostFields = ["oldItemCostCents", ...NON_REFUNDABLE_FEE_KINDS.map(feeField)];
const quantityIdentityFields = new Set<keyof PricingItem>(["name", "vendor", "sku", "specification", "category", "unitLabel"]);
const drawerHeading = "text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]";

export function PricingWorkspaceView({ projectKey, guide }: { projectKey: CaseKey; guide?: ReactNode }) {
  const readiness = useTryReadiness(projectKey);
  const state = usePricingWorkspace(projectKey);
  const { workspace, input, setInput } = state;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rawByEpoch, setRawByEpoch] = useState<{ epoch: number; values: RawFields; errors: RawFields }>({ epoch: -1, values: {}, errors: {} });
  const raw = rawByEpoch.epoch === state.editorEpoch ? rawByEpoch.values : {};
  const numericErrors = rawByEpoch.epoch === state.editorEpoch ? rawByEpoch.errors : {};
  const hasInvalidNumbers = Object.keys(numericErrors).length > 0;
  const stale = state.sourceStale || state.draftBaselineStale || Boolean(workspace?.stale && !state.adoptedLatest);
  const disabled = Boolean(state.busy || state.loading || stale || state.pendingCheck || state.conflict || state.choicesPending || !workspace?.sourceDraft);
  // The change open in the details drawer; none until the designer opens one from the grid.
  const selected = input?.changes.find((change) => change.key === selectedKey) ?? null;
  const selectedIndex = selected && input ? input.changes.indexOf(selected) : -1;
  const selectedBefore = selected ? workspace?.quote.lines.find((line) => line.itemId === selected.itemId) : undefined;
  const selectedItem = selected?.after ?? selectedBefore;
  const closeDetails = useCallback(() => setSelectedKey(null), []);
  // After sending, the page hands over to the project chat, where the client confirms.
  const [openingChat, setOpeningChat] = useState(false);
  const leaving = useRef<number | null>(null);
  useEffect(() => () => { if (leaving.current !== null) window.clearTimeout(leaving.current); }, []);

  // The guide's Review button opens the first change still to check, beside its row.
  useEffect(() => {
    if (!input) return;
    const openFirst = () => {
      const first = input.changes.find((change) => !change.confirmed) ?? input.changes[0];
      if (!first) return;
      setSelectedKey(first.key);
      document.getElementById("pricing-changes")?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(OPEN_FIRST_CHANGE_EVENT, openFirst);
    return () => window.removeEventListener(OPEN_FIRST_CHANGE_EVENT, openFirst);
  }, [input]);
  // A line that comes back from V1, compared live against V1 as the designer edits it.
  const selectedV1Line = selected && input ? workspace?.sourceDraft?.changes[input.changes.indexOf(selected)]?.fromV1?.line : undefined;
  const baselineTotals = useMemo(() => workspace ? calculateQuoteTotals(workspace.quote.lines) : null, [workspace]);
  const preview = useMemo(() => {
    if (!workspace?.sourceDraft || !input || stale || hasInvalidNumbers) return null;
    try { return previewPricing(workspace.quote, workspace.sourceDraft, input); }
    catch { return null; }
  }, [workspace, input, stale, hasInvalidNumbers]);
  const issuedForSavedReview = Boolean(state.lastOrder && workspace?.review && state.lastOrder.order.reviewId === workspace.review.id && state.lastOrder.order.reviewVersion === workspace.review.version);
  const canSave = Boolean(input && workspace?.sourceDraft && !disabled && !hasInvalidNumbers && (!state.saved || state.adoptedLatest));
  const nextVersion = workspace ? Math.max(workspace.quote.version, ...workspace.orders.map((order) => order.version)) + 1 : null;
  const client = clientOf(projectKey);
  const clientFirstName = client.name.split(" ")[0];
  const canIssue = Boolean(state.saved && preview?.ready && workspace && !workspace.stale && !disabled && !issuedForSavedReview && !hasInvalidNumbers && !readiness.blocked);
  const sampleMaterialsAvailable = Boolean(workspace && input && canLoadMapleSampleMaterials(workspace.quote, input));

  function loadSampleMaterials() {
    if (disabled || !workspace || !input) return;
    const filled = loadMapleSampleMaterials(workspace.quote, input);
    if (!filled) return;
    setInput(filled);
    setRawByEpoch({ epoch: state.editorEpoch, values: {}, errors: {} });
    setSelectedKey(filled.changes.find((change) => change.itemId === "chair")?.key ?? null);
  }

  function patchChange(key: string, patch: Partial<PricingChangeInput>) {
    setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => change.key === key ? { ...change, ...patch } : change) } : previous);
  }

  function patchAfter<K extends keyof PricingItem>(key: string, field: K, value: PricingItem[K]) {
    const previousChange = input?.changes.find((change) => change.key === key);
    if (previousChange?.action === "quantity" && quantityIdentityFields.has(field)) return;
    const previousItem = workspace?.quote.lines.find((line) => line.itemId === previousChange?.itemId);
    if (field === "quantity" && previousChange?.after && requiresOldItemHandling(previousChange, previousItem) !== requiresOldItemHandling({ ...previousChange, after: { ...previousChange.after, [field]: value } }, previousItem)) {
      dropRaw(key, oldCostFields);
    }
    setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => {
      if (change.key !== key || !change.after) return change;
      const before = workspace?.quote.lines.find((line) => line.itemId === change.itemId);
      const updated = { ...change, confirmed: false, after: { ...change.after, [field]: value } };
      const wasRequired = requiresOldItemHandling(change, before);
      const isRequired = requiresOldItemHandling(updated, before);
      if (isRequired && !wasRequired) return { ...updated, oldItemHandling: "pending" as const, oldItemCostCents: null, oldItemFees: [], oldItemNote: "" };
      if (!isRequired && wasRequired) return { ...updated, oldItemHandling: "not_applicable" as const, oldItemCostCents: 0, oldItemFees: [], oldItemNote: "" };
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

  function dropRaw(key: string, fields: string[]) {
    setRawByEpoch((previous) => {
      if (previous.epoch !== state.editorEpoch) return previous;
      const values = { ...previous.values };
      const errors = { ...previous.errors };
      for (const field of fields) { delete values[fieldKey(key, field)]; delete errors[fieldKey(key, field)]; }
      return { ...previous, values, errors };
    });
  }

  /** The old-item cost is the sum of its fees; it stays unknown while a fee has no amount, or until there are fees or "no fee" is chosen. */
  function updateFees(key: string, update: (fees: PricingChangeInput["oldItemFees"]) => PricingChangeInput["oldItemFees"]) {
    setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => {
      if (change.key !== key) return change;
      const fees = update(change.oldItemFees);
      const total = fees.length && fees.every((fee) => fee.amountCents !== null) ? fees.reduce((sum, fee) => sum + fee.amountCents!, 0) : null;
      return { ...change, oldItemFees: fees, oldItemCostCents: total, confirmed: false };
    }) } : previous);
  }

  function editFeeAmount(key: string, kind: NonRefundableFeeKind, value: string) {
    const parsed = parseDollars(value);
    setRaw(key, feeField(kind), value, parsed.error);
    if (parsed.error) patchChange(key, { confirmed: false });
    else updateFees(key, (fees) => fees.map((fee) => fee.kind === kind ? { ...fee, amountCents: parsed.value } : fee));
  }

  function changeFeeKind(key: string, from: NonRefundableFeeKind, to: NonRefundableFeeKind) {
    dropRaw(key, [feeField(from)]);
    updateFees(key, (fees) => fees.map((fee) => fee.kind === from ? { ...fee, kind: to } : fee));
  }

  function removeFee(key: string, kind: NonRefundableFeeKind) {
    dropRaw(key, [feeField(kind)]);
    updateFees(key, (fees) => fees.filter((fee) => fee.kind !== kind));
  }

  function addFee(key: string) {
    updateFees(key, (fees) => {
      const kind = NON_REFUNDABLE_FEE_KINDS.find((candidate) => !fees.some((fee) => fee.kind === candidate));
      return kind ? [...fees, { kind, amountCents: null }] : fees;
    });
  }

  const header = <header className="mb-5 flex flex-wrap items-center gap-3"><a href={`/chats/${projectKey}`} className="flex items-center gap-1.5 text-[12px] text-slate-500 hover:text-slate-900"><ArrowLeft className="h-3.5 w-3.5" />Back to project chat</a><span className="ml-auto rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Demo designer workspace</span></header>;

  return (
    <div id="pricing-workspace" data-pricing-source-stale={stale ? "true" : "false"} className={`min-h-dvh bg-[var(--canvas)] px-3 py-5 text-[var(--ink)] transition-[padding] duration-200 sm:px-6 ${selected ? "lg:pr-[504px]" : ""}`}>
      <main className="mx-auto max-w-[1360px]">
        {/* The walkthrough guide stays in view while the page scrolls, and moves aside with the content when the drawer opens. */}
        {guide && <div className="sticky top-0 z-30 -mx-3 -mt-5 mb-4 bg-[var(--canvas)] px-3 pb-3 pt-3 sm:-mx-6 sm:px-6">{guide}</div>}
        {header}
        <div className="mb-6"><div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500"><ClipboardCheck className="h-4 w-4" />{workspace?.quote.projectName ?? projectKey} · Designer pricing</div><h1 className="text-[26px] font-semibold tracking-tight">Review the change before issuing it</h1><p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-slate-500">Check prices, old-item handling and unresolved details. Save your review, then send it to the client as a new version in the project chat. V1 remains unchanged.</p><p className="mt-2 text-[10px] text-slate-400">Demo designer · pricing edits are saved for this demo project and browser.</p></div>

        {state.loading && <div role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading pricing workspace…</div>}
        {state.error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] leading-relaxed text-red-800"><p className="whitespace-pre-wrap">{state.error}</p>{state.pendingCheck && <button onClick={() => void state.checkSavedStatus()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Check saved status</button>}{state.conflict && <button onClick={() => void state.reload()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Load saved review · discard local edits</button>}{!workspace && !state.loading && <button onClick={() => void state.reload()} className="mt-2 font-semibold underline">Try loading again</button>}</div>}
        {state.notice && <div role="status" className="mb-4 rounded-xl border border-brand-100 bg-brand-50 px-4 py-3 text-[12px] leading-relaxed text-brand-800">{state.notice}</div>}

        {workspace && (!workspace.sourceDraft || stale) && <div id="pricing-source-status" className="mb-5 scroll-mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900">
          <h2 className="font-semibold">{state.draftBaselineStale ? "The original quote behind this AI draft has changed" : workspace.sourceDraft ? state.baselineStale ? "This pricing review uses an older quote snapshot" : "The AI draft has changed" : "There is no current AI draft to price"}</h2>
          <p className="mt-1">{state.draftBaselineStale ? "This draft cannot be repriced against the current original quote. Return to the project chat and ask @Setti to prepare a new draft." : workspace.sourceDraft ? "Adopt the latest valid draft and quote explicitly before editing or generating another client version. Existing local pricing edits will be replaced." : "Return to the chat and ask @Setti to prepare a change draft. An earlier pricing review cannot be issued after its source draft is withdrawn."}</p>
          {workspace.sourceDraft && !state.draftBaselineStale && <button onClick={state.adoptLatest} disabled={Boolean(state.busy) || state.pendingCheck} className="mt-3 rounded-lg bg-amber-900 px-3 py-2 font-medium text-white disabled:opacity-50">Re-price from the latest draft</button>}
          {state.draftBaselineStale && <a href={`/chats/${projectKey}`} className="mt-3 inline-block font-semibold underline">Return to chat · ask @Setti for a new draft</a>}
        </div>}

        {state.carryConflicts.length > 0 && <CarryOverChoices conflicts={state.carryConflicts} choices={state.choices} onChoose={state.choose} disabled={Boolean(state.busy)} />}

        {workspace && input && <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3"><TotalTile label={`Approved V${workspace.quote.version} total · USD`} amount={baselineTotals?.totalCents ?? null} /><TotalTile label="Proposed quote total · USD" amount={preview?.proposedTotals?.totalCents ?? null} /><TotalTile label="Quote difference · USD" amount={preview?.deltaTotalCents ?? null} signed /></div>
          <p className="mb-5 flex items-start gap-2 text-[11px] leading-relaxed text-slate-500"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />The quote difference is not the amount to pay now. No approval, authorization, charge or refund happens on this page.</p>
          {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="mb-5 rounded-xl bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error} You can save this review; sending it to the client becomes available when setup finishes.</p>}

          {isHomeQuote(workspace.quote) && <section className="mb-5 space-y-3"><p className="text-[12px] leading-relaxed text-slate-600">The AI draft uses the discussion and these sample supplier documents. Review checks are preselected for this demo. Review the product choices, quantities, source prices and return costs; untick anything that needs work. These presets do not confirm actual measurements, supplier approval, orders or payments.</p><HomeSupplierDocuments text={workspace.sourceDraft?.sources.find((source) => source.id === HOME_EVIDENCE_ID)?.text || undefined} /></section>}

          {sampleMaterialsAvailable && <section aria-labelledby="maple-sample-title" className="mb-5 rounded-xl border border-brand-100 bg-brand-50/50 p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2"><h2 id="maple-sample-title" className="mr-auto text-[14px] font-semibold">Maple sample supplier documents</h2><span className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-brand-800">Fictional demo materials</span></div>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-600">{MAPLE_SAMPLE_MATERIALS.reference} · {MAPLE_SAMPLE_MATERIALS.supplier}. Prepared for this walkthrough; review these supplied examples before confirming the change.</p>
            <div className="mt-3 grid gap-3 text-[12px] sm:grid-cols-3">
              <div className="rounded-lg bg-white p-3"><h3 className="font-semibold">New writing desk</h3><p className="mt-1">1 each · {money(MAPLE_SAMPLE_MATERIALS.desk.unitPriceCents)}</p><p className="mt-1 text-[11px] text-slate-500">{MAPLE_SAMPLE_MATERIALS.desk.sku}<br />Line tax {money(0)} · delivery {money(0)}<br />Sample lead time: 14 days</p></div>
              <div className="rounded-lg bg-white p-3"><h3 className="font-semibold">Original lounge chair</h3><p className="mt-1">Not ordered · no non-refundable fee</p><p className="mt-1 text-[11px] text-slate-500">The sample cancellation note records no retained goods or cancellation cost.</p></div>
              <div className="rounded-lg bg-white p-3"><h3 className="font-semibold">Wool rug return</h3><p className="mt-1">{NON_REFUNDABLE_FEE_LABEL[MAPLE_SAMPLE_MATERIALS.rug.oldItemFees[0].kind]} {money(MAPLE_SAMPLE_MATERIALS.rug.oldItemFees[0].amountCents)}, not refunded</p><p className="mt-1 text-[11px] text-slate-500">The sample return note leaves {money(24_000)} to refund after matching supplier credit.</p></div>
            </div>
            <details className="mt-3 text-[11px] leading-relaxed text-slate-600"><summary className="cursor-pointer font-medium">Read sample terms and source notes</summary><div className="mt-2 space-y-2"><p>{MAPLE_SAMPLE_MATERIALS.desk.returnPolicy}</p><p>{MAPLE_SAMPLE_MATERIALS.chair.note}</p><p>{MAPLE_SAMPLE_MATERIALS.rug.note}</p><p>{MAPLE_SAMPLE_MATERIALS.terms}</p></div></details>
            <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" disabled={disabled} onClick={loadSampleMaterials} className="rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] disabled:opacity-50">Load sample supplier details</button><p className="flex-1 text-[11px] leading-relaxed text-slate-500">Fills editable prices, references and terms. Check each changed row and resolve the open questions yourself, then save the review.</p></div>
          </section>}

          <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]"><span className={`rounded-full px-2.5 py-1 ${state.saved && !hasInvalidNumbers ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{state.saved && !hasInvalidNumbers ? `Saved review ${workspace.review?.version}` : "Unsaved pricing edits"}</span><span className="text-slate-400">{workspace.sourceDraft?.model === "designer" ? "Designer draft" : "AI draft"} revision {workspace.sourceDraft?.revision ?? "withdrawn"} · V{workspace.quote.version} is read-only</span>{!state.busy && !state.pendingCheck && <button onClick={() => void state.reload()} className="ml-auto flex items-center gap-1 text-slate-500 hover:underline"><RefreshCw className="h-3 w-3" />Reload saved review · discard local edits</button>}</div>

          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><Field label="Client change-order title"><input aria-label="Client change-order title" className={inputClass} value={input.title} disabled={disabled} onChange={(event) => setInput((previous) => previous ? { ...previous, title: event.target.value } : previous)} /></Field><p className="mt-3 text-[11px] leading-relaxed text-slate-600">{input.changes.filter((change) => change.confirmed).length} of {input.changes.length} changes checked. Review the details and old-item handling for every row; all changes are issued together as one client version.</p><div id="pricing-changes" className="mt-4"><PricingGrid changes={input.changes} baselineLines={workspace.quote.lines} raw={raw} disabled={disabled} selectedKey={selected?.key ?? null} onSelect={setSelectedKey} onEdit={editGridField} /></div></section>

          {selected && <ChangeDrawer index={selectedIndex} count={input.changes.length} action={selected.action} title={selectedItem?.name || "Original item"}
            subtitle={selectedItem ? [selectedItem.vendor, selectedItem.sku].filter(Boolean).join(" · ") : undefined}
            onPrevious={() => setSelectedKey(input.changes[selectedIndex - 1]?.key ?? selected.key)} onNext={() => setSelectedKey(input.changes[selectedIndex + 1]?.key ?? selected.key)} onClose={closeDetails}
            footer={<label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed"><input aria-label="Designer confirmed this change" type="checkbox" disabled={disabled} checked={selected.confirmed} onChange={(event) => patchChange(selected.key, { confirmed: event.target.checked })} className="mt-0.5" /><span>{isHomeQuote(workspace.quote) ? "Demo check preselected. Review this change, its price, purchase unit and applicable terms. Editing a value clears this check." : "I have checked this change, its price, purchase unit and applicable terms. Editing a value clears this check."}</span></label>}>
            <fieldset disabled={disabled} className="min-w-0 space-y-6"><FromV1Note fromV1={selected.fromV1} changes={selectedV1Line && selected.after ? differences(selectedV1Line, selected.after) : undefined} listChanges />{selected.action === "quantity" && <p className="rounded-lg bg-brand-50 px-3 py-2 text-[11px] leading-relaxed text-brand-800">This is the original product. Its name, seller, reference, specification, category and purchase unit stay fixed. To choose a different product, return to the chat and ask @Setti for a replacement draft.</p>}
              {selected.after && <>
                <section className="space-y-3"><h3 className={drawerHeading}>Item</h3>
                  <Field label="Proposed item name"><input aria-label="Proposed item name" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.name} onChange={(event) => patchAfter(selected.key, "name", event.target.value)} /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Seller / supplier"><input aria-label="Seller / supplier" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.vendor} onChange={(event) => patchAfter(selected.key, "vendor", event.target.value)} /></Field>
                    <Field label="Brand"><input aria-label="Brand" className={inputClass} value={selected.after.brand ?? ""} onChange={(event) => patchAfter(selected.key, "brand", event.target.value || null)} /></Field>
                    <Field label="SKU / item reference"><input aria-label="SKU / item reference" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.sku} onChange={(event) => patchAfter(selected.key, "sku", event.target.value)} /></Field>
                    <Field label="Room / scope"><input aria-label="Room / scope" className={inputClass} value={selected.after.room} onChange={(event) => patchAfter(selected.key, "room", event.target.value)} /></Field>
                    <Field label="Category"><select aria-label="Category" disabled={selected.action === "quantity"} className={inputClass} value={selected.after.category} onChange={(event) => patchAfter(selected.key, "category", event.target.value === "service" ? "service" : "furniture")}><option value="furniture">Product</option><option value="service">Service</option></select></Field>
                  </div>
                </section>
                <section className="space-y-3"><h3 className={drawerHeading}>Price</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Quantity" error={numericErrors[fieldKey(selected.key, "quantity")]}><input aria-label="Quantity" inputMode="numeric" className={inputClass} value={raw[fieldKey(selected.key, "quantity")] ?? String(selected.after.quantity)} onChange={(event) => editGridField(selected.key, "quantity", event.target.value)} /></Field>
                    <Field label="Purchase unit" hint="For example: each, hour or 2-pack."><input aria-label="Purchase unit" readOnly={selected.action === "quantity"} className={inputClass} value={selected.after.unitLabel} onChange={(event) => patchAfter(selected.key, "unitLabel", event.target.value)} /></Field>
                    <div className="col-span-2"><Field label="Verified quote currency" hint="Verify the amount before confirming USD; no currency conversion is performed."><select aria-label="Verified quote currency" className={inputClass} value={selected.after.currency ?? ""} onChange={(event) => patchAfter(selected.key, "currency", event.target.value || null)}><option value="">Unconfirmed currency</option><option value="USD">USD · designer verified</option>{selected.after.currency && selected.after.currency !== "USD" && <option value={selected.after.currency}>{selected.after.currency} · must be repriced in USD</option>}</select></Field></div>
                    {([{ field: "unitPriceCents", label: `Unit price (${selected.after.currency ?? "currency unconfirmed"})` }, { field: "taxCents", label: "Whole-line tax" }, { field: "freightCents", label: "Whole-line delivery" }] as const).map(({ field, label }) => <Field key={field} label={label} error={numericErrors[fieldKey(selected.key, field)]}><input aria-label={label} inputMode="decimal" className={inputClass} placeholder="Unknown" value={raw[fieldKey(selected.key, field)] ?? centsText(selected.after?.[field] ?? null)} onChange={(event) => editGridField(selected.key, field, event.target.value)} /></Field>)}
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-400">The unit price is per purchase unit. Tax and delivery are totals for the whole line; enter 0 explicitly when checked and not applicable.</p>
                </section>
                <section className="space-y-3"><h3 className={drawerHeading}>Terms and evidence</h3>
                  <Field label="Specification / selected options"><textarea aria-label="Specification / selected options" readOnly={selected.action === "quantity"} rows={3} className={inputClass} value={selected.after.specification} onChange={(event) => patchAfter(selected.key, "specification", event.target.value)} /></Field>
                  <Field label="Price evidence" hint="Record the document, quote, checked date and selected price or option."><textarea aria-label="Price evidence" rows={4} className={inputClass} value={selected.priceEvidence} onChange={(event) => patchChange(selected.key, { priceEvidence: event.target.value, confirmed: false })} /></Field>
                  <Field label="Source URL" hint="Optional when the evidence is a supplier document or manual quote."><input aria-label="Source URL" type="url" className={inputClass} value={selected.after.sourceUrl ?? ""} onChange={(event) => patchAfter(selected.key, "sourceUrl", event.target.value || null)} /></Field>
                  <Field label="Return / cancellation policy"><textarea aria-label="Return / cancellation policy" rows={4} className={inputClass} value={selected.after.returnPolicy} onChange={(event) => patchAfter(selected.key, "returnPolicy", event.target.value)} /></Field>
                  <div className="grid grid-cols-2 items-end gap-3"><Field label="Return eligibility"><select aria-label="Return eligibility" className={inputClass} value={selected.after.returnable === null ? "unknown" : selected.after.returnable ? "yes" : "no"} onChange={(event) => patchAfter(selected.key, "returnable", event.target.value === "unknown" ? null : event.target.value === "yes")}><option value="unknown">Not confirmed · see policy</option><option value="yes">Returnable under stated policy</option><option value="no">Not returnable</option></select></Field><label className="flex items-center gap-2 py-2 text-[12px] text-slate-600"><input type="checkbox" checked={selected.after.customMade} onChange={(event) => patchAfter(selected.key, "customMade", event.target.checked)} />Custom-made item</label></div>
                </section>
              </>}

              {requiresOldItemHandling(selected, selectedBefore) && <section className="space-y-3 rounded-xl border border-amber-100 bg-amber-50/40 p-4"><h3 className={drawerHeading}>Original item · handling and remaining cost</h3>{selectedBefore && <p className="text-[11px] text-slate-500">V{workspace.quote.version}: {selectedBefore.quantity} × {selectedBefore.name} · original whole-line total {money(calculateLineTotals(selectedBefore).totalCents)} including tax and delivery.</p>}<Field label="Old item handling"><select aria-label="Old item handling" className={inputClass} value={selected.oldItemHandling} onChange={(event) => patchChange(selected.key, { oldItemHandling: event.target.value as OldItemHandling, confirmed: false })}>{(["pending", "not_ordered", "cancelled", "modified", "returned", "retained"] as const).map((handling) => <option key={handling} value={handling}>{handlingLabels[handling]}</option>)}</select></Field><OldItemFees change={selected} raw={raw} errors={numericErrors} onAmount={(kind, value) => editFeeAmount(selected.key, kind, value)} onKind={(from, to) => changeFeeKind(selected.key, from, to)} onRemove={(kind) => removeFee(selected.key, kind)} onAdd={() => addFee(selected.key)} onNone={() => patchChange(selected.key, { oldItemFees: [], oldItemCostCents: 0, confirmed: false })} /><Field label="Old-item handling note"><textarea aria-label="Old-item handling note" rows={3} className={inputClass} value={selected.oldItemNote} onChange={(event) => patchChange(selected.key, { oldItemNote: event.target.value, confirmed: false })} /></Field></section>}
            </fieldset>
          </ChangeDrawer>}

          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><h2 className="mb-4 text-[14px] font-semibold">Review the draft’s open items</h2><p className="mb-4 text-[12px] text-slate-500">Review each check before sending. Additional notes are optional.</p><fieldset disabled={disabled} className="space-y-4">{input.issues.length === 0 && <p className="text-[12px] text-slate-500">No open items were supplied by this draft.</p>}{input.issues.map((issue, index) => <div key={issue.id} className="rounded-lg border border-slate-200 p-3"><label className="flex items-start gap-2 text-[12px] leading-relaxed"><input aria-label={`Resolve issue ${index + 1}`} type="checkbox" checked={issue.resolved} onChange={(event) => setInput((previous) => previous ? { ...previous, issues: previous.issues.map((entry) => entry.id === issue.id ? { ...entry, resolved: event.target.checked } : entry) } : previous)} className="mt-0.5" /><span>{issue.label}</span></label><textarea aria-label={`Resolution note ${index + 1}`} rows={2} placeholder="Optional: add context about this check for the client." className={`${inputClass} mt-2`} value={issue.note} onChange={(event) => setInput((previous) => previous ? { ...previous, issues: previous.issues.map((entry) => entry.id === issue.id ? { ...entry, note: event.target.value } : entry) } : previous)} /></div>)}</fieldset></section>

          {workspace.sourceDraft?.constraints.length ? <section className="mb-5 rounded-xl border border-brand-100 bg-brand-50 p-4 text-[12px] leading-relaxed text-brand-900"><h2 className="mb-2 font-semibold">Instructions carried into the client version</h2><ul className="list-disc space-y-1 pl-4">{workspace.sourceDraft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></section> : null}
          <ChangeSourceFields value={input.source ?? draftSource({ supplierNotice: workspace.sourceDraft?.supplierNotice })} disabled={disabled} onChange={(source) => setInput((previous) => previous ? { ...previous, source } : previous)} />
          <section className="mb-5 rounded-xl bg-white p-4 shadow-sm sm:p-5"><fieldset disabled={disabled} className="grid gap-4 lg:grid-cols-2"><Field label="Client terms" hint="Required. State scope, delivery assumptions, cancellation terms and what this version asks the client to confirm."><textarea aria-label="Client terms" rows={5} className={inputClass} value={input.terms} onChange={(event) => setInput((previous) => previous ? { ...previous, terms: event.target.value, changes: previous.changes.map((change) => ({ ...change, confirmed: false })) } : previous)} /></Field><Field label="Designer review notes" hint="These notes will also be frozen into the read-only client version."><textarea aria-label="Designer review notes" rows={5} className={inputClass} value={input.reviewNotes} onChange={(event) => setInput((previous) => previous ? { ...previous, reviewNotes: event.target.value } : previous)} /></Field></fieldset></section>

          {(hasInvalidNumbers || preview?.problems.length) ? <section role="status" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900"><h2 className="mb-2 font-semibold">Before sending it to the client</h2><ul className="list-disc space-y-1 pl-4">{Object.values(numericErrors).map((problem, index) => <li key={`number-${index}`}>{problem}</li>)}{preview?.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></section> : null}

          <div className="sticky bottom-0 z-10 mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur"><span className="mr-auto flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">{issuedForSavedReview && state.lastOrder ? <><Check className="h-3.5 w-3.5 text-emerald-600" /><span className="font-medium text-emerald-800">Sent to {client.name} as V{state.lastOrder.order.version} in the project chat.</span>{openingChat ? <span>Opening the project chat…</span> : <a href={`/chats/${projectKey}`} className="font-semibold text-[var(--primary)] underline">Open the chat</a>}</> : preview?.ready && !hasInvalidNumbers ? <><Check className="h-3.5 w-3.5 text-emerald-600" />{canSave ? `Checks complete. Save the review, then send it to ${clientFirstName}.` : "Checks complete · review saved."}</> : "Incomplete reviews can be saved. Complete every check before sending."}</span>
            {/* One primary step at a time: save while there are unsaved edits, then send. */}
            <button onClick={() => void state.save()} disabled={!canSave} className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12px] disabled:opacity-40 ${canSave ? "bg-[var(--primary-fill)] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]" : "border border-slate-200 font-medium hover:bg-slate-50"}`}>{state.busy === "save" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save pricing review</button><button onClick={() => { if (canIssue) void state.issue().then((sent) => { if (!sent) return; setOpeningChat(true); leaving.current = window.setTimeout(() => window.location.assign(`/chats/${projectKey}`), 1500); }); }} disabled={!canIssue} className="flex items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-4 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:bg-slate-200 disabled:font-medium disabled:text-slate-400">{state.busy === "issue" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}{issuedForSavedReview && state.lastOrder ? `Sent as V${state.lastOrder.order.version}` : `Send to ${clientFirstName} as V${nextVersion}`}</button></div>
        </>}

        {state.lastOrder && <section className="mb-5 rounded-xl border border-emerald-100 bg-emerald-50 p-5"><h2 className="text-[14px] font-semibold text-emerald-900">Frozen client version · V{state.lastOrder.order.version}</h2><p className="mt-1 text-[12px] leading-relaxed text-emerald-800">{changeOrderStatusLabel(state.lastOrder.status)}. {state.lastOrder.status === "superseded" ? "A newer client version exists. This link remains a historical snapshot." : state.lastOrder.status === "approved" ? "The client's decision is saved against this frozen version. Payment execution is a separate step." : state.lastOrder.status === "declined" ? "Discuss the requested adjustments and prepare a new version." : `Sent to ${client.name} in the project chat; ${client.name.split(" ")[0]} confirms it from the card there. Sharing this link grants read-only access.`}</p><a href={`/change-orders/${state.lastOrder.order.id}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 break-all text-[12px] font-semibold text-emerald-900 underline">Open local client review<ArrowUpRight className="h-3.5 w-3.5 shrink-0" /></a><LocalShareLink path={`/change-orders/${state.lastOrder.order.id}`} /><p className="mt-2 text-[10px] text-emerald-700">Local demo link · accessible while this instance is running. Nothing was sent outside this app.</p></section>}

        {workspace && workspace.orders.length > 0 && <section className="rounded-xl bg-white p-5 shadow-sm"><h2 className="mb-3 text-[14px] font-semibold">Issued version history</h2><ul className="divide-y divide-slate-100">{[...workspace.orders].sort((a, b) => b.version - a.version).map((order) => <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-[12px]"><a href={`/change-orders/${order.id}`} target="_blank" rel="noreferrer" className="font-medium text-[var(--primary)] hover:underline">V{order.version} · {changeOrderStatusLabel(order.status)}</a><span className="text-[10px] text-slate-400">{dateTime(order.issuedAt)}</span><span className="font-medium tabular-nums">{money(order.totalCents)}</span></li>)}</ul></section>}
      </main>
    </div>
  );
}

