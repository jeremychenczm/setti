"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAiInvocation } from "@/ai/intent";
import type { AiStage, AppendMessageInput, CaseKey, CaseMessage, CaseSnapshot, ChatErrorResponse, HumanActor } from "@/chat/types";

interface RetryAction {
  messageId?: string;
  input?: AppendMessageInput;
}

function isSnapshot(value: unknown, projectKey: CaseKey): value is CaseSnapshot {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<CaseSnapshot>;
  return state.projectKey === projectKey && Array.isArray(state.messages) && !!state.opening && (state.quote === null || state.quote?.projectId === projectKey);
}

async function readResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function useCaseChat(projectKey: CaseKey) {
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const [optimistic, setOptimistic] = useState<CaseMessage | null>(null);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const endpoint = `/api/chat/${projectKey}`;
  const [stage, setStage] = useState<AiStage | null>(null);
  // Whether this reply needed a corrected attempt, so the steps can show it.
  const [rewrote, setRewrote] = useState(false);
  // Whether the message being sent asks Setti, so only those sends show reply steps.
  const [sendingToAi, setSendingToAi] = useState(false);

  // While a message is sending, read the reply's real stage from the saved case; the reply itself arrives with the send.
  useEffect(() => {
    if (!sending) { setStage(null); setRewrote(false); return; }
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        const body = await readResponse(response);
        if (!stopped && response.ok && isSnapshot(body, projectKey)) {
          const current = body.activeMessageId ? body.activeRunStage ?? null : null;
          setStage(current);
          if (current === "rewriting") setRewrote(true);
        }
      } catch { /* progress only; the send reports the outcome */ }
    }, 1200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [sending, endpoint, projectKey]);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
      const body = await readResponse(response);
      if (!response.ok || !isSnapshot(body, projectKey)) {
        throw new Error((body as ChatErrorResponse | null)?.error ?? "The conversation could not be loaded.");
      }
      if (alive.current) {
        setSnapshot(body);
        setOptimistic(null);
      }
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The conversation could not be loaded.");
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, projectKey]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!snapshot?.activeMessageId || sending) return;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
        const body = await readResponse(response);
        if (response.ok && isSnapshot(body, projectKey) && !controller.signal.aborted) {
          setSnapshot(body);
          if (!retryAction?.input) setError(null);
        } else if (!controller.signal.aborted) {
          setError((body as ChatErrorResponse | null)?.error ?? "Could not refresh the AI response. Retrying shortly…");
        }
      } catch {
        if (!controller.signal.aborted) setError("Connection interrupted. Checking the saved conversation…");
      } finally {
        polling = false;
      }
    };
    const interval = window.setInterval(() => void poll(), 2500);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [endpoint, projectKey, snapshot?.activeMessageId, sending, retryAction?.input]);

  const submit = useCallback(async (action: RetryAction) => {
    if (busy.current || snapshot?.activeMessageId) return;
    if (optimistic && retryAction?.input && action.input?.id !== retryAction.input.id) return;
    busy.current = true;
    setSending(true);
    setSendingToAi(Boolean(action.messageId) || isAiInvocation(action.input?.text ?? ""));
    setError(null);
    setRetryAction(null);
    const controller = new AbortController();
    request.current = controller;
    if (action.input) {
      setOptimistic({ ...action.input, createdAt: new Date().toISOString(), replyToMessageId: null, aiState: "none", error: null, model: null });
    }
    try {
      const response = await fetch(`${endpoint}${action.messageId ? "/retry" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.messageId ? { messageId: action.messageId } : action.input),
        signal: controller.signal,
      });
      const body = await readResponse(response);
      if (!alive.current || controller.signal.aborted) return;
      if (!response.ok) {
        const failure = body as ChatErrorResponse | null;
        const savedMessage = failure?.state?.messages.find((message) => message.id === (action.messageId ?? action.input?.id));
        if (isSnapshot(failure?.state, projectKey)) {
          setSnapshot(failure.state);
          if (savedMessage) setOptimistic(null);
        }
        setRetryAction(savedMessage?.aiState === "failed" ? { messageId: savedMessage.id } : action);
        setError(failure?.error ?? "The message could not be processed. Please retry.");
        return;
      }
      if (!isSnapshot(body, projectKey)) throw new Error("The server returned an unexpected conversation. Please reload the chat.");
      setSnapshot(body);
      setOptimistic(null);
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Connection interrupted. Please retry the same message.");
        setRetryAction(action);
        // A response can be lost after the message was saved. Recover that state
        // before offering a retry; the original message UUID remains unchanged.
        try {
          const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
          const recovered = await readResponse(response);
          if (alive.current && response.ok && isSnapshot(recovered, projectKey)) {
            setSnapshot(recovered);
            const message = recovered.messages.find((entry) => entry.id === (action.messageId ?? action.input?.id));
            if (message) setOptimistic(null);
            if (message?.aiState === "failed") setRetryAction({ messageId: message.id });
            else if (message && message.aiState !== "running") {
              setRetryAction(null);
              setError(null);
            }
          }
        } catch {
          // The retry still uses the same UUID if the connection remains down.
        }
      }
    } finally {
      busy.current = false;
      if (alive.current && !controller.signal.aborted) setSending(false);
    }
  }, [endpoint, projectKey, snapshot?.activeMessageId, optimistic, retryAction?.input]);

  const send = useCallback((actor: HumanActor, text: string) => submit({ input: { id: crypto.randomUUID(), actor, text } }), [submit]);
  const retry = useCallback((messageId?: string) => {
    const action = messageId ? { messageId } : retryAction;
    if (action) void submit(action);
  }, [retryAction, submit]);
  const editUnsent = useCallback(() => {
    if (!optimistic || !retryAction?.input) return null;
    const unsent = retryAction.input;
    setOptimistic(null);
    setRetryAction(null);
    setError(null);
    return unsent;
  }, [optimistic, retryAction]);

  /**
   * Sends V1 with the designer's message. The caller keeps `id` for retries, so a
   * lost response never posts the quote twice. Returns an error to show, or null.
   */
  const sendQuote = useCallback(async (id: string, text: string): Promise<string | null> => {
    try {
      const response = await fetch(`${endpoint}/quote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text }) });
      const body = await readResponse(response);
      if (!response.ok) return (body as ChatErrorResponse | null)?.error ?? "The quote could not be sent. Please retry.";
      if (!isSnapshot(body, projectKey)) return "The server returned an unexpected conversation. Please reload the chat.";
      if (alive.current) setSnapshot(body);
      return null;
    } catch {
      return "Connection interrupted. Retry: the same send cannot post the quote twice.";
    }
  }, [endpoint, projectKey]);

  const messages = snapshot?.messages ?? [];
  return {
    snapshot,
    messages: optimistic && !messages.some((message) => message.id === optimistic.id) ? [...messages, optimistic] : messages,
    loading,
    running: sending || Boolean(snapshot?.activeMessageId),
    stage: stage ?? (snapshot?.activeMessageId ? snapshot.activeRunStage ?? null : null),
    rewrote,
    aiReplying: Boolean(snapshot?.activeMessageId) || (sending && sendingToAi),
    error,
    canRetry: Boolean(retryAction),
    unsavedMessageId: optimistic && !messages.some((message) => message.id === optimistic.id) ? optimistic.id : null,
    hasUnsent: Boolean(optimistic && retryAction?.input),
    send,
    sendQuote,
    retry,
    editUnsent,
    reload: load,
  };
}
