"use client";

import { Check, EyeOff, LoaderCircle, Plus, Redo2, Save, Send, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CaseKey } from "@/chat/types";
import { canLoadMapleSampleMaterials, loadMapleSampleMaterials, MAPLE_SAMPLE_MATERIALS } from "@/demo/maple-materials";
import { draftSource, orderedUnits, previewPricing, requiresOldItemHandling } from "@/pricing/calculation";
import { NON_REFUNDABLE_FEE_KINDS } from "@/pricing/fees";
import { feeField, OldItemFees } from "./OldItemFees";
import type { NonRefundableFeeKind, OldItemHandling, PricingChangeInput, PricingItem } from "@/pricing/types";
import { calculateLineTotals, calculateQuoteTotals } from "@/quotes/totals";
import { centsText, Field, inputClass, money, parseDollars, FromV1Note } from "./common";
import { fieldKey, INTERNAL_COLUMNS, QuoteItemsGrid, type EditableGridField, type ItemsColumns, type ItemsView, type RawFields } from "./QuoteItemsGrid";
import { QuotePreview, VersionMenu } from "./QuotePreview";
import { ChangeTotalCard } from "./TotalCard";
import { DraftedBySetti, EditorCrumbs, EditorLayout, GHOST, ItemsCard, PreviewButton, ProjectInfoCard, SELECT, SEND, SendBar, SumCard, SumRow, Todo, TOOL } from "./EditorFrame";
import { draftReceipt } from "./draft-receipt";
import { BrandMark } from "../BrandMark";
import { usePricingWorkspace } from "./usePricingWorkspace";
import { differences } from "@/pricing/review-diff";
import { CarryOverChoices } from "./CarryOverChoices";
import { ChangeDrawer, OPEN_FIRST_CHANGE_EVENT } from "./ChangeDrawer";
import { ChangeSourceFields } from "./ChangeSource";
import { HOME_EVIDENCE_ID, isHomeQuote } from "@/demo/home-evidence";
import { HomeSupplierDocuments } from "../try/HomeSupplierDocuments";
import { useTryReadiness } from "../try/useTryReadiness";
import { BackToChat } from "../BackToChat";

const handlingLabels: Record<OldItemHandling, string> = { pending: "Not checked yet", not_ordered: "Not ordered", cancelled: "Order cancelled", modified: "Modified (re-made or re-sized)", returned: "Returned / return arranged", retained: "Retained in the project", not_applicable: "Not applicable" };
const oldCostFields = ["oldItemCostCents", ...NON_REFUNDABLE_FEE_KINDS.map(feeField)];
const quantityIdentityFields = new Set<keyof PricingItem>(["name", "vendor", "sku", "specification", "category", "unitLabel"]);
const drawerHeading = "text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]";

/** The designer's quote editor for the open draft. `embedded` inside the Quotes module, whose sidebar and guide are the page's. */
export function PricingWorkspaceView({ projectKey, clientName, studioName = "", guide, embedded = false }: { projectKey: CaseKey; clientName: string; studioName?: string; guide?: ReactNode; embedded?: boolean }) {
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
  // How the quote items are shown; none of it changes the quote.
  const [view, setView] = useState<ItemsView>("section");
  const [columnsShown, setColumnsShown] = useState<ItemsColumns>({ type: true, supplier: true, sku: false, source: false });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => () => { if (leaving.current !== null) window.clearTimeout(leaving.current); }, []);

  // Undo and redo step through the designer's edits since the review was loaded.
  type Input = NonNullable<typeof input>;
  const steps = useRef<{ epoch: number; past: Input[]; future: Input[]; last: Input | null; replaying: boolean }>({ epoch: -1, past: [], future: [], last: null, replaying: false });
  const [history, setHistory] = useState({ past: 0, future: 0 });
  useEffect(() => {
    const record = steps.current;
    if (record.epoch !== state.editorEpoch) Object.assign(record, { epoch: state.editorEpoch, past: [], future: [], last: input, replaying: false });
    else if (record.replaying) Object.assign(record, { last: input, replaying: false });
    else if (input && record.last && record.last !== input) { record.past.push(record.last); record.future = []; record.last = input; }
    else record.last = input;
    setHistory({ past: record.past.length, future: record.future.length });
  }, [input, state.editorEpoch]);
  function replay(from: "past" | "future") {
    const record = steps.current;
    const target = record[from].pop();
    if (!target || !input) return;
    record[from === "past" ? "future" : "past"].push(input);
    record.replaying = true;
    setRawByEpoch({ epoch: state.editorEpoch, values: {}, errors: {} });
    setInput(target);
  }
  const undo = () => replay("past");
  const redo = () => replay("future");

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
  const clientFirstName = clientName.split(" ")[0];
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

  /** Moves a line before or after another; the order is saved with the review and frozen into the version. */
  function moveLine(token: string, target: string, place: "before" | "after") {
    setInput((previous) => {
      if (!previous || !workspace || token === target) return previous;
      const all = [...workspace.quote.lines.map((line) => ({ token: line.itemId })), ...previous.changes.filter((change) => change.action === "add").map((change) => ({ token: change.key }))];
      const rest = orderedUnits(all, previous.lineOrder).map((unit) => unit.token).filter((entry) => entry !== token);
      const at = rest.indexOf(target) + (place === "after" ? 1 : 0);
      return { ...previous, lineOrder: [...rest.slice(0, at), token, ...rest.slice(at)] };
    });
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

  const drafted = workspace?.sourceDraft ? workspace.sourceDraft.model !== "designer" : false;
  const checks = input ? { done: input.changes.filter((change) => change.confirmed).length, all: input.changes.length } : { done: 0, all: 0 };
  const answers = input ? { done: input.issues.filter((issue) => issue.resolved).length, all: input.issues.length } : { done: 0, all: 0 };
  const keptFees = input && workspace ? input.changes.reduce((sum, change) => requiresOldItemHandling(change, workspace.quote.lines.find((line) => line.itemId === change.itemId)) ? sum + (change.oldItemCostCents ?? 0) : sum, 0) : 0;
  const projectName = workspace?.quote.projectName ?? projectKey;
  const checkLines = (keys: string[], confirmed: boolean) => setInput((previous) => previous ? { ...previous, changes: previous.changes.map((change) => keys.includes(change.key) ? { ...change, confirmed } : change) } : previous);
  const resolveIssue = (id: string, resolved: boolean) => setInput((previous) => previous ? { ...previous, issues: previous.issues.map((issue) => issue.id === id ? { ...issue, resolved } : issue) } : previous);
  const designerName = workspace?.quote.designerName.replace(/\s*\(demo designer\)$/, "") ?? "";
  const created = workspace?.review?.createdAt ?? workspace?.sourceDraft?.createdAt ?? null;
  const createdLabel = created ? new Date(created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }) : "Today";

  return (
    <div id="pricing-workspace" data-pricing-source-stale={stale ? "true" : "false"} className={embedded ? "min-w-0 text-[12.5px] text-[var(--ink)]" : "min-h-dvh bg-[var(--canvas)] px-3 py-5 text-[12.5px] text-[var(--ink)] sm:px-6"}>
      {/* The walkthrough guide stays in view while the page scrolls. */}
      {guide && <div className="sticky top-0 z-30 -mx-3 -mt-5 mb-3 bg-[var(--canvas)] px-3 pb-3 pt-3 sm:-mx-6 sm:px-6">{guide}</div>}
      <EditorLayout
        main={<>
          <EditorCrumbs name={projectName} right={<>{!embedded && <BackToChat projectKey={projectKey} />}{workspace && <VersionMenu projectKey={projectKey} quote={workspace.quote} orders={workspace.orders} draftVersion={issuedForSavedReview ? null : nextVersion} />}</>} />

          {state.loading && <div role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />Loading the quote…</div>}
          {state.error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] leading-relaxed text-red-800"><p className="whitespace-pre-wrap">{state.error}</p>{state.pendingCheck && <button onClick={() => void state.checkSavedStatus()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Check saved status</button>}{state.conflict && <button onClick={() => void state.reload()} disabled={Boolean(state.busy)} className="mt-2 font-semibold underline disabled:opacity-50">Load saved review · discard local edits</button>}{!workspace && !state.loading && <button onClick={() => void state.reload()} className="mt-2 font-semibold underline">Try loading again</button>}</div>}
          {state.notice && <div role="status" className="rounded-xl border border-brand-100 bg-brand-50 px-4 py-3 text-[12px] leading-relaxed text-brand-800">{state.notice}</div>}
          {workspace && (!workspace.sourceDraft || stale) && <div id="pricing-source-status" className="scroll-mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900">
            <h2 className="font-semibold">{state.draftBaselineStale ? "The original quote behind this AI draft has changed" : workspace.sourceDraft ? state.baselineStale ? "This pricing review uses an older quote snapshot" : "The AI draft has changed" : "There is no current AI draft to price"}</h2>
            <p className="mt-1">{state.draftBaselineStale ? "This draft cannot be repriced against the current original quote. Return to the project chat and ask @Setti to prepare a new draft." : workspace.sourceDraft ? "Adopt the latest valid draft and quote explicitly before editing or generating another client version. Existing local pricing edits will be replaced." : "Return to the chat and ask @Setti to prepare a change draft. An earlier pricing review cannot be issued after its source draft is withdrawn."}</p>
            {workspace.sourceDraft && !state.draftBaselineStale && <button onClick={state.adoptLatest} disabled={Boolean(state.busy) || state.pendingCheck} className="mt-3 rounded-lg bg-amber-900 px-3 py-2 font-medium text-white disabled:opacity-50">Re-price from the latest draft</button>}
            {state.draftBaselineStale && <a href={`/chats/${projectKey}`} className="mt-3 inline-block font-semibold underline">Return to chat · ask @Setti for a new draft</a>}
          </div>}
          {state.carryConflicts.length > 0 && <CarryOverChoices conflicts={state.carryConflicts} choices={state.choices} onChoose={state.choose} disabled={Boolean(state.busy)} />}
          {(readiness.pending || Boolean(readiness.blocked && readiness.error)) && <p role="status" className="rounded-xl bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900">{readiness.notice ?? readiness.error} You can save this review; sending it to the client becomes available when setup finishes.</p>}

          {workspace && input && <>
            <ProjectInfoCard open={infoOpen} onToggle={() => setInfoOpen((open) => !open)} summary={`${projectName} · ${clientName} · Quote V${nextVersion} · ${issuedForSavedReview ? "Sent" : "Draft"}`}
              badge={drafted ? <DraftedBySetti /> : undefined}
              studio={{ name: studioName || designerName, person: `${designerName} · Designer`, note: "Studio details from Settings" }}
              client={<><b className="text-[13.5px] font-bold">{clientName}</b><span className="text-[12.5px]">{projectName}</span><span className="text-[12.5px] text-[var(--muted)]">Signs in the project chat</span></>}
              title={projectName}
              meta={[{ label: "Created", value: createdLabel }, { label: "Currency", value: "USD" }]}
              quote={{ version: nextVersion ?? "", sent: issuedForSavedReview, status: issuedForSavedReview ? "Sent, awaiting signature" : "Draft", note: issuedForSavedReview ? "Frozen. Open it from the version list to read what the client received." : "Only you can see this draft." }} />

            <ItemsCard open={itemsOpen} onToggle={() => setItemsOpen((open) => !open)}
              summary={`${workspace.quote.lines.length + input.changes.filter((change) => change.action === "add").length - input.changes.filter((change) => change.action === "remove").length} items · V${nextVersion} total ${money(preview?.proposedTotals?.totalCents ?? null)}`}
              tools={<>
                {/* A change is the lines Setti drafted from the conversation; a new line or section comes in through Setti's draft. */}
                <button type="button" disabled title="In a change, ask Setti to add it to the draft" className={TOOL}><Plus className="h-[15px] w-[15px]" />Add section</button>
                <button type="button" disabled title="In a change, ask Setti to add it to the draft" className={TOOL}><Plus className="h-[15px] w-[15px]" />Add item</button>
                <a href={`/chats/${projectKey}`} className={`${TOOL} text-[var(--primary)]`}><BrandMark className="h-[15px] w-[15px]" />Ask Setti to draft the change</a>
                <button type="button" onClick={undo} disabled={disabled || !history.past} aria-label="Undo" title="Undo" className={TOOL}><Undo2 className="h-[15px] w-[15px]" /></button>
                <button type="button" onClick={redo} disabled={disabled || !history.future} aria-label="Redo" title="Redo" className={TOOL}><Redo2 className="h-[15px] w-[15px]" /></button>
                <span className="flex-1" />
                <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted)]">View by<select aria-label="View by" value={view} onChange={(event) => setView(event.target.value as ItemsView)} className={SELECT}><option value="section">Section</option><option value="supplier">Supplier</option><option value="change">Change</option></select></label>
                <span className="relative">
                  <button type="button" onClick={() => setColumnsOpen((open) => !open)} aria-expanded={columnsOpen} className={GHOST}>Columns</button>
                  {columnsOpen && <div role="dialog" aria-label="Columns" className="absolute right-0 top-[calc(100%+6px)] z-20 grid w-56 gap-0.5 rounded-[10px] border border-[var(--line)] bg-white p-2 shadow-lg">
                    {INTERNAL_COLUMNS.map((column) => <label key={column.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-[5px] text-[12px] hover:bg-[var(--canvas)]"><input type="checkbox" checked={columnsShown[column.key]} onChange={(event) => setColumnsShown((shown) => ({ ...shown, [column.key]: event.target.checked }))} /><span className="flex-1">{column.label}</span><EyeOff className="h-3.5 w-3.5 text-[var(--muted)]" aria-label="Hidden from the client" /></label>)}
                    <p className="mt-1 border-t border-[var(--line)] px-1.5 pt-1 text-[11px] text-[var(--muted)]">Columns with <EyeOff className="inline h-3 w-3" /> never appear on the quote the client receives.</p>
                  </div>}
                </span>
                <PreviewButton onClick={() => { setColumnsOpen(false); setPreviewing(true); }} />
              </>}>
              <div id="pricing-changes"><QuoteItemsGrid changes={input.changes} baselineLines={workspace.quote.lines} issues={input.issues} raw={raw} disabled={disabled} drafted={drafted} view={view} columns={columnsShown}
                selectedKey={selected?.key ?? null} onSelect={setSelectedKey} onEdit={editGridField} onCheck={checkLines} onResolve={resolveIssue} onMove={moveLine} lineOrder={input.lineOrder} /></div>
            </ItemsCard>
          </>}
        </>}
        side={workspace && input ? <>
          <SumRow>
            <SumCard label="Terms">
              <div className="grid gap-2.5">
                <label htmlFor="client-terms" className="text-[15px] font-bold">Terms the client signs</label>
                <fieldset disabled={disabled} className="grid gap-2.5">
                  <textarea id="client-terms" aria-label="Client terms" className="min-h-[150px] w-full resize-y rounded-lg border border-[var(--line)] bg-white px-2.5 py-2 text-[12px] leading-normal text-[var(--ink)] outline-none focus:border-[#cfcab9] disabled:bg-slate-50" value={input.terms} onChange={(event) => setInput((previous) => previous ? { ...previous, terms: event.target.value, changes: previous.changes.map((change) => ({ ...change, confirmed: false })) } : previous)} />
                  {workspace.sourceDraft?.constraints.length ? <div className="rounded-lg bg-[var(--canvas)] px-3 py-2 text-[11.5px] leading-relaxed text-slate-600"><p className="font-semibold text-[var(--ink)]">Also frozen into V{nextVersion}</p><ul className="mt-1 list-disc space-y-0.5 pl-4">{workspace.sourceDraft.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></div> : null}
                  <Field label="Note to the client (optional)" hint="Frozen into the version with the terms."><textarea aria-label="Designer review notes" rows={3} className={inputClass} value={input.reviewNotes} onChange={(event) => setInput((previous) => previous ? { ...previous, reviewNotes: event.target.value } : previous)} /></Field>
                </fieldset>
                <ChangeSourceFields value={input.source ?? draftSource({ supplierNotice: workspace.sourceDraft?.supplierNotice })} disabled={disabled} onChange={(source) => setInput((previous) => previous ? { ...previous, source } : previous)} />
              </div>
            </SumCard>
            <ChangeTotalCard baseVersion={workspace.quote.version} version={nextVersion} previousCents={baselineTotals?.totalCents ?? null} nextCents={preview?.proposedTotals?.totalCents ?? null} keptCents={keptFees}>
              {(hasInvalidNumbers || preview?.problems.length) ? <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11.5px] leading-relaxed text-amber-900"><p className="font-semibold">Before sending it to the client</p><ul className="mt-1 list-disc space-y-0.5 pl-4">{Object.values(numericErrors).map((problem, index) => <li key={`number-${index}`}>{problem}</li>)}{preview?.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul></div> : null}
            </ChangeTotalCard>
          </SumRow>
          {isHomeQuote(workspace.quote) && <HomeSupplierDocuments text={workspace.sourceDraft?.sources.find((source) => source.id === HOME_EVIDENCE_ID)?.text || undefined} />}
          {sampleMaterialsAvailable && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-100 bg-brand-50/50 px-3 py-2.5 text-[12px]"><span className="flex-1">{MAPLE_SAMPLE_MATERIALS.reference} · {MAPLE_SAMPLE_MATERIALS.supplier}: fictional supplier details for this walkthrough.</span><button type="button" disabled={disabled} onClick={loadSampleMaterials} className="rounded-lg bg-[var(--primary-fill)] px-3 py-1.5 font-semibold text-[var(--on-primary)] disabled:opacity-50">Load sample supplier details</button></div>}
        </> : null}
        bar={workspace && input ? <SendBar>
          {issuedForSavedReview && state.lastOrder
            ? <span className="flex flex-1 flex-wrap items-center gap-1.5 text-[12px]"><Check className="h-3.5 w-3.5 text-emerald-600" /><span className="font-medium text-emerald-800">Sent to {clientName} as V{state.lastOrder.order.version}.</span>{openingChat ? <span className="text-[var(--muted)]">Opening the project chat…</span> : <a href={`/chats/${projectKey}`} className="font-semibold text-[var(--primary)] underline">Open the chat</a>}</span>
            : <span className="flex flex-1 flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-[#4b5348]">
              {drafted && <Todo done={checks.done === checks.all}>Check what Setti drafted · {checks.done} of {checks.all}</Todo>}
              {answers.all > 0 && <Todo done={answers.done === answers.all}>Answer Setti&apos;s questions · {answers.done} of {answers.all}</Todo>}
              <Todo done={Boolean(preview?.ready && !hasInvalidNumbers)}>{preview?.ready && !hasInvalidNumbers ? "Every amount is complete" : "Some amounts are missing"}</Todo>
            </span>}
          {/* One primary step at a time: save while there are unsaved edits, then send. */}
          <span className="text-[11.5px] text-[var(--muted)]">{state.saved && !hasInvalidNumbers ? `Saved review ${workspace.review?.version}` : "Unsaved edits"}</span>
          <button onClick={() => void state.save()} disabled={!canSave} className={canSave ? SEND : GHOST}>{state.busy === "save" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save</button>
          <button onClick={() => { if (canIssue) void state.issue().then((sent) => { if (!sent) return; setOpeningChat(true); leaving.current = window.setTimeout(() => window.location.assign(`/chats/${projectKey}`), 1500); }); }} disabled={!canIssue} className={SEND}>{state.busy === "issue" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-[15px] w-[15px]" />}{issuedForSavedReview && state.lastOrder ? `Sent as V${state.lastOrder.order.version}` : `Send to ${clientFirstName} as V${nextVersion}`}</button>
        </SendBar> : null} />
          {workspace && input && selected && <ChangeDrawer index={selectedIndex} count={input.changes.length} action={selected.action} title={selectedItem?.name || "Original item"}
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
        {previewing && workspace && input && <QuotePreview receipt={draftReceipt({ workspace, input, preview, nextVersion: nextVersion ?? workspace.quote.version + 1, clientName })} onClose={() => setPreviewing(false)} />}
    </div>
  );
}
