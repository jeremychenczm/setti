import { createHash } from "node:crypto";
import type { ChatStore, CaseKey, StoredCase, ProductPage } from "./types";
import { caseQuote } from "./cases";
import { aiTask, isAiInvocation } from "@/ai/intent";
import { aiConfigured, callChangeModel } from "@/ai/model";
import { buildDraft } from "@/ai/draft";
import { readProductPage } from "@/ai/product-page";
import { buildMoneyAnswer, hasUnsupportedMoneyClaim, isMoneyQuestion } from "@/ai/money-answer";

export function messageUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'，。！？；、）》）\u3000]+/gu) ?? [];
  return matches.map((value) => value.replace(/[，。！？；、）》）\]),;.!?]+$/gu, ""));
}

export function failedPage(url: string, error: string): ProductPage {
  return { id: `page-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`, url, fetchedAt: new Date().toISOString(), title: url, text: "", products: [], error };
}

/** Changes are drafted against a V1 the client approved; before that the AI says so instead of drafting. */
const OPENING_GUIDANCE = {
  draft: "Quote V1 has not been sent to the client yet. The designer sends it from the + menu in this chat; changes can be drafted once the client confirms it.",
  sent: "Quote V1 is with the client for review. Changes can be drafted once the client confirms V1.",
} as const;

export interface DraftDependencies {
  readPage: typeof readProductPage;
  callModel: typeof callChangeModel;
  configured: () => boolean;
}

export async function runCaseAi(store: ChatStore, sessionId: string, key: CaseKey, messageId: string, dependencies?: Partial<DraftDependencies>): Promise<StoredCase> {
  const deps: DraftDependencies = { readPage: readProductPage, callModel: callChangeModel, configured: aiConfigured, ...dependencies };
  const start = await store.beginAi(sessionId, key, messageId);
  if (start.status !== "started") {
    if (start.status === "completed") return start.state;
    throw new CaseAiError("The AI is already working on another message in this project. Try again shortly.");
  }
  const { runId, state } = start;
  try {
    if (state.opening && state.opening.status !== "approved") {
      return await store.completeAi(sessionId, key, messageId, runId, { text: OPENING_GUIDANCE[state.opening.status], model: "system" });
    }
    const triggerIndex = state.messages.findIndex((message) => message.id === messageId);
    const trigger = state.messages[triggerIndex];
    if (!trigger || trigger.actor === "assistant" || !isAiInvocation(trigger.text)) throw new Error("Only your own @AI messages can be retried.");
    if (!aiTask(trigger.text)) {
      return await store.completeAi(sessionId, key, messageId, runId, { text: "Should I explain the quote or draft a change? Say what to adjust, or attach a product link.", model: "system" });
    }
    if (!deps.configured()) throw new Error("The model API is not configured. Set the server key and restart, then retry this message. No AI draft was created.");
    const messages = state.messages.slice(0, triggerIndex + 1);
    const urls = [...new Set(messages.filter((message) => message.actor !== "assistant").flatMap((message) => messageUrls(message.text)))];
    const moneyQuestion = isMoneyQuestion(trigger.text);
    const moneyContext = store.readMoneyContext ? await store.readMoneyContext(sessionId, key) : null;
    const quote = state.quote ?? caseQuote(key);
    if (moneyContext && (moneyContext.quoteId !== quote.id || moneyContext.version !== quote.version || moneyContext.projectKey !== key)) throw new Error("The approved version for this project has changed. Send a new @AI request.");
    // A read-only money question must not fetch stale product links or be blocked by their count.
    const deferPages = moneyQuestion || urls.length > 4;
    const pages = deferPages ? [] : await Promise.all(urls.map(async (url) => {
      try { return await deps.readPage(url); }
      catch (error) { return failedPage(url, error instanceof Error ? error.message : "Could not read the product page."); }
    }));
    const result = await deps.callModel({ quote, messages, pages, current: state.draft, triggerId: messageId, moneyContext });
    if (result.output.intent === "money") {
      if (!moneyContext || result.output.changes.length || !result.output.money) throw new Error("Missing money evidence");
      const generated = buildMoneyAnswer(moneyContext, result.output.money.factIds);
      return await store.completeAi(sessionId, key, messageId, runId, { ...generated, model: result.model });
    }
    if (result.output.money != null || (moneyQuestion && result.output.intent !== "clarify") || (["answer", "clarify"].includes(result.output.intent) && hasUnsupportedMoneyClaim(result.output.message))) throw new Error("Ungrounded financial answer");
    if (deferPages && urls.length > 4 && result.output.intent === "draft") throw new Error("This test version reads at most 4 different product links per project. Your message is saved; no links or chat history were dropped.");
    const output = { ...result.output };
    delete output.money;
    const generated = buildDraft({ output, quote, messages, pages, current: state.draft, triggerId: messageId, model: result.model });
    return await store.completeAi(sessionId, key, messageId, runId, { ...generated, model: result.model });
  } catch (error) {
    // Never persist API error bodies, secrets, SQL, or upstream request headers.
    let userError = "The AI request or result validation failed, so the draft was not updated. Check the model configuration and network, then retry.";
    if (error instanceof Error && !error.message.match(/(?:api[_ -]?key|bearer|sk-ant-|select |insert |postgres|password)/iu)) {
      if (/^(The approved version for this project|This project's context|This test version|The model API is not configured|The model did not return|Only your own @AI)/u.test(error.message)) userError = error.message;
    }
    await store.failAi(sessionId, key, messageId, runId, userError);
    throw new CaseAiError(userError);
  }
}

export class CaseAiError extends Error {}
