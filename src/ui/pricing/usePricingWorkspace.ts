"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CaseKey } from "@/chat/types";
import { createPricingInput } from "@/pricing/calculation";
import { quoteFingerprint } from "@/quotes/fingerprint";
import type { ChangeOrderView, IssuePricingInput, PricingInput, PricingWorkspace, SavePricingInput } from "@/pricing/types";

type PendingCheck = { kind: "save"; payload: SavePricingInput; reason: string } | { kind: "issue"; payload: IssuePricingInput; reason: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function sameInput(left: PricingInput, right: PricingInput): boolean { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function workspaceBody(value: unknown, key: CaseKey): value is PricingWorkspace {
  return Boolean(value && typeof value === "object" && "projectKey" in value && value.projectKey === key && "quote" in value && "orders" in value);
}
function orderBody(value: unknown): value is ChangeOrderView {
  return Boolean(value && typeof value === "object" && "order" in value && "status" in value);
}
async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? String(body.error) : `Request failed (${response.status}).`;
    const problems = body && typeof body === "object" && "problems" in body && Array.isArray(body.problems) ? body.problems.filter((problem): problem is string => typeof problem === "string") : [];
    throw new Error([message, ...problems.map((problem) => `• ${problem}`)].join("\n"));
  }
  return body;
}

export function usePricingWorkspace(projectKey: CaseKey) {
  const [workspace, setWorkspace] = useState<PricingWorkspace | null>(null);
  const [input, setInput] = useState<PricingInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "issue" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingCheck, setPendingCheck] = useState<PendingCheck | null>(null);
  const [conflict, setConflict] = useState(false);
  const [adoptedLatest, setAdoptedLatest] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editorSource, setEditorSource] = useState<{ id: string; revision: number } | null>(null);
  const [lastOrder, setLastOrder] = useState<ChangeOrderView | null>(null);
  const alive = useRef(true);
  const mutating = useRef(false);
  const endpoint = `/api/pricing/${projectKey}`;
  const currentQuote = workspace?.quote;
  const currentBaselineFingerprint = useMemo(() => currentQuote ? quoteFingerprint(currentQuote) : null, [currentQuote]);

  const getWorkspace = useCallback(async () => {
    const body = await requestJson(endpoint);
    if (!workspaceBody(body, projectKey)) throw new Error("The server returned a different pricing workspace.");
    return body;
  }, [endpoint, projectKey]);

  const applySaved = useCallback((state: PricingWorkspace) => {
    setWorkspace(state);
    let nextInput = state.review ? structuredClone(state.review.input) : null;
    if (!nextInput && state.sourceDraft && (!state.sourceDraft.basedOnQuoteFingerprint || state.sourceDraft.basedOnQuoteFingerprint === quoteFingerprint(state.quote))) {
      try { nextInput = createPricingInput(state.quote, state.sourceDraft); }
      catch (cause) { setError(`${cause instanceof Error ? cause.message : "The AI draft no longer matches the original quote."} Return to the chat and ask @AI to prepare a new draft.`); }
    }
    setInput(nextInput);
    setEditorSource(state.review ? { id: state.review.sourceDraftId, revision: state.review.sourceDraftRevision } : state.sourceDraft ? { id: state.sourceDraft.id, revision: state.sourceDraft.revision } : null);
    setAdoptedLatest(false);
    setConflict(false);
    setPendingCheck(null);
    setEditorEpoch((epoch) => epoch + 1);
  }, []);

  const reload = useCallback(async () => {
    if (mutating.current) return;
    setLoading(true);
    setError(null);
    try {
      const state = await getWorkspace();
      if (!alive.current) return;
      applySaved(state);
      const latest = [...state.orders].sort((a, b) => b.version - a.version)[0];
      if (latest) {
        try {
          const order = await requestJson(`/api/change-orders/${latest.id}`);
          if (alive.current && orderBody(order)) setLastOrder(order);
        } catch { /* The saved pricing workspace remains usable if the separate link is unavailable. */ }
      } else setLastOrder(null);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not load pricing.");
    } finally { if (alive.current) setLoading(false); }
  }, [getWorkspace, applySaved]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  const adoptLatest = useCallback(() => {
    if (!workspace?.sourceDraft || mutating.current) return;
    if (workspace.sourceDraft.basedOnQuoteFingerprint && workspace.sourceDraft.basedOnQuoteFingerprint !== quoteFingerprint(workspace.quote)) {
      setError("The AI draft was prepared against a different original quote. Return to the chat and ask @AI for a new draft before pricing it.");
      return;
    }
    try { setInput(createPricingInput(workspace.quote, workspace.sourceDraft)); }
    catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "This draft cannot be repriced against the current quote."} Return to the chat and ask @AI to prepare a new draft.`);
      return;
    }
    setEditorSource({ id: workspace.sourceDraft.id, revision: workspace.sourceDraft.revision });
    setAdoptedLatest(true);
    setConflict(false);
    setPendingCheck(null);
    setError(null);
    setNotice("Latest AI draft adopted. Previous local pricing edits were replaced. Review every row and save before generating a client version.");
    setEditorEpoch((epoch) => epoch + 1);
  }, [workspace]);

  const reconcile = useCallback(async (pending: PendingCheck) => {
    const state = await getWorkspace();
    if (!alive.current) return;
    setWorkspace(state);
    if (pending.kind === "save") {
      const review = state.review;
      if (review && review.version > 0 && review.sourceDraftId === pending.payload.sourceDraftId && review.sourceDraftRevision === pending.payload.sourceDraftRevision && sameInput(review.input, pending.payload.input)) {
        applySaved(state);
        setNotice(`Save confirmed on the server · review ${review.version}.`);
        setError(null);
        return;
      }
      const currentVersion = review && review.version > 0 ? review.version : null;
      if (currentVersion !== pending.payload.expectedVersion) {
        setConflict(true);
        setError(`${pending.reason}\nThe saved review changed while this request was in progress. Your local edits are still visible. Load the saved review before continuing.`);
      } else {
        setError(`${pending.reason}\nNo completed save was found. Your unsaved edits are preserved; save again when ready.`);
      }
    } else {
      for (const summary of [...state.orders].sort((a, b) => b.version - a.version)) {
        const result = await requestJson(`/api/change-orders/${summary.id}`);
        if (!alive.current) return;
        if (orderBody(result) && result.order.reviewId === pending.payload.reviewId && result.order.reviewVersion === pending.payload.expectedVersion) {
          setLastOrder(result);
          setNotice(`Client change order V${result.order.version} confirmed. No approval or payment has occurred.`);
          const reviewChanged = !state.review || state.review.id !== pending.payload.reviewId || state.review.version !== pending.payload.expectedVersion;
          setConflict(reviewChanged);
          setError(reviewChanged ? "The requested client version was found, but the saved pricing review has since changed. Load the saved review before making further edits." : null);
          setPendingCheck(null);
          return;
        }
      }
      if (!state.review || state.review.id !== pending.payload.reviewId || state.review.version !== pending.payload.expectedVersion) setConflict(true);
      setError(`${pending.reason}\nNo change order for this saved review was found. Check the saved review before trying again.`);
    }
    setPendingCheck(null);
  }, [getWorkspace, applySaved]);

  const checkSavedStatus = useCallback(async () => {
    if (!pendingCheck || mutating.current) return;
    mutating.current = true;
    setBusy("check");
    try { await reconcile(pendingCheck); }
    catch { if (alive.current) setError("Could not verify the saved result. Check the saved status again before retrying a mutation."); }
    finally { mutating.current = false; if (alive.current) setBusy(null); }
  }, [pendingCheck, reconcile]);

  const save = useCallback(async () => {
    if (!workspace?.sourceDraft || !input || mutating.current || pendingCheck || conflict || !editorSource || editorSource.id !== workspace.sourceDraft.id || editorSource.revision !== workspace.sourceDraft.revision || input.baselineFingerprint !== currentBaselineFingerprint || (workspace.sourceDraft.basedOnQuoteFingerprint && workspace.sourceDraft.basedOnQuoteFingerprint !== currentBaselineFingerprint)) return;
    const payload: SavePricingInput = {
      sourceDraftId: workspace.sourceDraft.id, sourceDraftRevision: workspace.sourceDraft.revision,
      expectedVersion: workspace.review && workspace.review.version > 0 ? workspace.review.version : null,
      input: structuredClone(input),
    };
    mutating.current = true;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const body = await requestJson(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!workspaceBody(body, projectKey)) throw new Error("The save response was incomplete.");
      if (alive.current) { applySaved(body); setNotice(`Pricing saved · review ${body.review?.version ?? ""}. Generate a client version separately when ready.`); }
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : "Save failed.");
      const pending: PendingCheck = { kind: "save", payload, reason: cause instanceof Error ? cause.message : "Save failed." };
      setPendingCheck(pending);
      try { await reconcile(pending); }
      catch { if (alive.current) setError("The save response was lost and its result could not be verified. Check saved status before retrying."); }
    } finally { mutating.current = false; if (alive.current) setBusy(null); }
  }, [workspace, input, pendingCheck, conflict, editorSource, currentBaselineFingerprint, endpoint, projectKey, applySaved, reconcile]);

  const issue = useCallback(async () => {
    if (!workspace?.review || workspace.review.version < 1 || mutating.current || pendingCheck || conflict || !input || input.baselineFingerprint !== currentBaselineFingerprint || (workspace.sourceDraft?.basedOnQuoteFingerprint && workspace.sourceDraft.basedOnQuoteFingerprint !== currentBaselineFingerprint)) return;
    const payload: IssuePricingInput = { reviewId: workspace.review.id, expectedVersion: workspace.review.version };
    mutating.current = true;
    setBusy("issue"); setError(null); setNotice(null);
    try {
      const body = await requestJson(`${endpoint}/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!orderBody(body)) throw new Error("The change-order response was incomplete.");
      if (!alive.current) return;
      setLastOrder(body);
      setNotice(`Client change order V${body.order.version} generated. The link is read-only and awaits client confirmation.`);
      try {
        const state = await getWorkspace();
        if (alive.current) {
          setWorkspace(state);
          if (!state.review || state.review.id !== payload.reviewId || state.review.version !== payload.expectedVersion) {
            setConflict(true);
            setError("The client version was generated, but the saved pricing review has since changed. Load the saved review before making further edits.");
          }
        }
      } catch { if (alive.current) setNotice(`Client change order V${body.order.version} was generated. The saved history could not be refreshed; the read-only link below is valid.`); }
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : "Could not generate the client version.");
      const pending: PendingCheck = { kind: "issue", payload, reason: cause instanceof Error ? cause.message : "Could not generate the client version." };
      setPendingCheck(pending);
      try { await reconcile(pending); }
      catch { if (alive.current) setError("The generation response was lost. Check saved status before trying to generate another version."); }
    } finally { mutating.current = false; if (alive.current) setBusy(null); }
  }, [workspace, input, currentBaselineFingerprint, pendingCheck, conflict, endpoint, getWorkspace, reconcile]);

  const saved = Boolean(workspace?.review && workspace.review.version > 0 && input && input.baselineFingerprint === currentBaselineFingerprint && sameInput(workspace.review.input, input) && !adoptedLatest);
  const draftBaselineStale = Boolean(workspace?.sourceDraft?.basedOnQuoteFingerprint && workspace.sourceDraft.basedOnQuoteFingerprint !== currentBaselineFingerprint);
  const baselineStale = Boolean(workspace && input && input.baselineFingerprint !== currentBaselineFingerprint);
  const sourceStale = baselineStale || Boolean(workspace?.sourceDraft && editorSource && (editorSource.id !== workspace.sourceDraft.id || editorSource.revision !== workspace.sourceDraft.revision));
  return { workspace, input, setInput, loading, busy, error, notice, pendingCheck: Boolean(pendingCheck), conflict, saved, adoptedLatest, sourceStale, baselineStale, draftBaselineStale, editorEpoch, lastOrder, reload, adoptLatest, save, issue, checkSavedStatus };
}
