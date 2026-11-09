import { createHash } from "node:crypto";
import type { AiStage, ChatStore, CaseKey, ChangeDraft, StoredCase, ProductPage } from "./types";
import { preapprovedQuote } from "./cases";
import { isAiInvocation } from "@/ai/intent";
import { aiConfigured, callChangeModel, type ChangeModelOutput } from "@/ai/model";
import { buildDraft, draftReplyProblems, InvalidAiOutputError } from "@/ai/draft";
import { readProductPage } from "@/ai/product-page";
import { answerFactIds, buildMoneyAnswer, hasUnsupportedMoneyClaim, isMoneyQuestion, verifyMoneyAnswer } from "@/ai/money-answer";
import { quoteMessageProblems, quoteQueryProblems, runQuoteQuery, type QuoteAnswer } from "@/ai/quote-query";
import type { MoneyAnswer } from "@/ai/money-types";
import { HOME_EVIDENCE_PAGE, isHomeQuote } from "@/demo/home-evidence";

export function messageUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gu) ?? [];
  return matches.map((value) => value.replace(/[\]),;.!?]+$/gu, ""));
}

export function failedPage(url: string, error: string): ProductPage {
  return { id: `page-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`, url, fetchedAt: new Date().toISOString(), title: url, text: "", products: [], error };
}

export interface DraftDependencies {
  readPage: typeof readProductPage;
  callModel: typeof callChangeModel;
  configured: () => boolean;
}

type Reply = { text: string; draft?: ChangeDraft | null; moneyAnswer?: MoneyAnswer; quoteAnswer?: QuoteAnswer };
/** A model result either passes verification, or says what to fix and what the records alone can still show. */
type Checked = { ok: true; reply: Reply } | { ok: false; problems: string[]; fallback?: Reply };

/** System notices used only when Setti's own reply failed verification twice; they never speak as Setti. */
const UNVERIFIED_QUOTE_TEXT = "Setti's sentence about this lookup did not pass verification, so only the matching quote lines are shown.";
function unverifiedDraftNotice(changeCount: number): string {
  return `Setti drafted ${changeCount} proposed change${changeCount === 1 ? "" : "s"} for designer review, but its reply did not pass verification, so this summary comes from the draft. Prices, taxes, delivery, old-item handling and any refund plan need verification. The draft does not approve orders or execute payments.`;
}
const CLIENT_REQUEST_NOTICE = "Your request is saved in this chat. Jordan prepares and checks the revised quote, then sends it for your confirmation. No draft was created or cancelled and no payment was made.";

export async function runCaseAi(store: ChatStore, sessionId: string, key: CaseKey, messageId: string, dependencies?: Partial<DraftDependencies>): Promise<StoredCase> {
  const deps: DraftDependencies = { readPage: readProductPage, callModel: callChangeModel, configured: aiConfigured, ...dependencies };
  const start = await store.beginAi(sessionId, key, messageId);
  if (start.status !== "started") {
    if (start.status === "completed") return start.state;
    throw new CaseAiError("The AI is already working on another message in this project. Try again shortly.");
  }
  const { runId, state } = start;
  try {
    const triggerIndex = state.messages.findIndex((message) => message.id === messageId);
    const trigger = state.messages[triggerIndex];
    if (!trigger || trigger.actor === "assistant" || !isAiInvocation(trigger.text)) throw new Error("Only your own @Setti messages can be retried.");
    if (!deps.configured()) throw new Error("The model API is not configured. Set the server key and restart, then retry this message. No AI draft was created.");
    // Before the client approves V1 there is nothing to change yet; Setti still answers, from where V1 stands.
    const openingStatus = state.opening && state.opening.status !== "approved" ? state.opening.status : null;
    const quote = openingStatus ? null : state.quote ?? preapprovedQuote(key);
    if (!openingStatus && !quote) throw new Error("This project's context has no approved quote yet. The client approves quote V1 first.");
    const messages = state.messages.slice(0, triggerIndex + 1);
    const urls = [...new Set(messages.filter((message) => message.actor !== "assistant").flatMap((message) => messageUrls(message.text)))];
    const moneyQuestion = isMoneyQuestion(trigger.text);
    const moneyContext = quote && store.readMoneyContext ? await store.readMoneyContext(sessionId, key) : null;
    if (quote && moneyContext && (moneyContext.quoteId !== quote.id || moneyContext.version !== quote.version || moneyContext.projectKey !== key)) throw new Error("The approved version for this project has changed. Send a new @Setti request.");
    // A read-only money question must not fetch stale product links or be blocked by their count.
    const deferPages = !quote || moneyQuestion || urls.length > 4;
    const pages = deferPages ? [] : await Promise.all(urls.map(async (url) => {
      try { return await deps.readPage(url); }
      catch (error) { return failedPage(url, error instanceof Error ? error.message : "Could not read the product page."); }
    }));
    if (quote && isHomeQuote(quote) && !moneyQuestion) pages.push(HOME_EVIDENCE_PAGE());
    // In the studio-led project the client discusses; the designer prepares every revised quote.
    const requesterMayDraft = !(quote && isHomeQuote(quote) && trigger.actor !== "designer");

    const check = (output: ChangeModelOutput, model: string): Checked => {
      const failed = (problems: string[], fallback?: Reply): Checked => ({ ok: false, problems, fallback });
      if (output.intent === "money") {
        if (!quote || !moneyContext) return failed(["This project has no recorded payments to explain yet: answer without money mode."]);
        if (output.changes.length || !output.money || output.quoteQuery != null) return failed(["A money answer sets changes=[], quoteQuery=null and gives money.answer."]);
        // The facts the answer cites are the evidence shown under it.
        const known = new Set(moneyContext.facts.map((fact) => fact.id));
        const cited = answerFactIds(output.money.answer);
        const shown = cited.filter((id) => known.has(id));
        const problems = verifyMoneyAnswer(moneyContext, output.money.answer);
        if (!cited.length) problems.push("The answer must cite at least one moneyEvidence fact.");
        if (problems.length) return failed(problems, shown.length ? buildMoneyAnswer(moneyContext, shown) : undefined);
        return { ok: true, reply: buildMoneyAnswer(moneyContext, shown, output.money.answer, output.money.showEvidence) };
      }
      if (output.intent === "quote") {
        if (!quote) return failed(["Quote V1 is not approved yet, so there are no approved lines to look up: answer where V1 stands instead."]);
        if (output.changes.length || output.money != null || !output.quoteQuery) return failed(["A quote lookup sets changes=[], money=null and gives quoteQuery."]);
        const queryProblems = quoteQueryProblems(output.quoteQuery);
        if (queryProblems.length) return failed(queryProblems);
        // The lines come from the server; only the sentence above them is the model's.
        const quoteAnswer = runQuoteQuery(quote, output.quoteQuery);
        const messageProblems = quoteMessageProblems(output.message, output.quoteQuery);
        if (messageProblems.length) return failed(messageProblems, { text: UNVERIFIED_QUOTE_TEXT, quoteAnswer });
        return { ok: true, reply: { text: output.message, quoteAnswer } };
      }
      const drafting = output.intent === "draft" || output.intent === "cancel";
      const problems: string[] = [];
      if (output.money != null) problems.push("Set money=null unless intent is money.");
      if (output.quoteQuery != null) problems.push("Set quoteQuery=null unless intent is quote.");
      if (moneyQuestion && moneyContext && output.intent !== "clarify") problems.push("This question asks to explain recorded money: use intent=money with facts from moneyEvidence, or clarify what to check.");
      if (!quote && drafting) problems.push("Quote V1 is not approved yet, so there is nothing to change: answer where V1 stands instead.");
      if (!requesterMayDraft && drafting) problems.push("The client cannot create or cancel drafts in this project: use intent=answer to acknowledge what they asked for and say the designer will prepare a revised quote for them to confirm.");
      if (output.intent !== "draft" && hasUnsupportedMoneyClaim(output.message)) problems.push("An answer or clarification cannot state amounts or payment statuses; payment questions use money mode.");
      if (problems.length) return failed(problems, !requesterMayDraft && drafting ? { text: CLIENT_REQUEST_NOTICE } : undefined);
      if (!quote) return { ok: true, reply: { text: output.message } };
      if (deferPages && urls.length > 4 && output.intent === "draft") throw new Error("This test version reads at most 4 different product links per project. Your message is saved; no links or chat history were dropped.");
      const draftOutput = { ...output };
      delete draftOutput.money;
      delete draftOutput.quoteQuery;
      let generated: ReturnType<typeof buildDraft>;
      try { generated = buildDraft({ output: draftOutput, quote, messages, pages, current: state.draft, triggerId: messageId, model }); }
      catch (error) {
        if (error instanceof InvalidAiOutputError) return failed([`The result did not validate against the approved quote: ${error.message}.`]);
        throw error;
      }
      if (!generated.draft) return { ok: true, reply: generated };
      // The reply and title are Setti's own words, checked against the quote and this draft's own figures.
      const replyProblems = draftReplyProblems(generated.text, generated.draft, quote);
      const plainTitle = !hasUnsupportedMoneyClaim(generated.draft.title);
      if (!plainTitle) replyProblems.push("The title becomes the client version's title: keep it plain English, without amounts or payment statuses.");
      if (replyProblems.length) {
        const text = unverifiedDraftNotice(generated.draft.changes.length);
        return failed(replyProblems, { text, draft: { ...generated.draft, summary: text, title: plainTitle ? generated.draft.title : "Change draft for designer review" } });
      }
      generated.draft.summary = generated.text;
      return { ok: true, reply: generated };
    };

    const ask = (previousAttemptProblems?: string[]) => deps.callModel({ quote, openingStatus, messages, pages, current: state.draft, triggerId: messageId, moneyContext, requesterMayDraft, previousAttemptProblems });
    // The waiting client shows each stage; progress is informational, so a failed report never stops the reply.
    const stage = async (next: AiStage) => { try { await store.reportAiStage?.(sessionId, key, runId, next); } catch { /* informational only */ } };
    await stage("writing");
    let result = await ask();
    await stage("checking");
    let checked = check(result.output, result.model);
    // A result that fails verification goes back to Setti once, with what to fix.
    if (!checked.ok) {
      await stage("rewriting");
      result = await ask(checked.problems);
      await stage("checking");
      checked = check(result.output, result.model);
    }
    if (checked.ok) return await store.completeAi(sessionId, key, messageId, runId, { ...checked.reply, model: result.model });
    // Twice unverified: show only what the records establish, as a system notice rather than in Setti's voice.
    if (checked.fallback) return await store.completeAi(sessionId, key, messageId, runId, { ...checked.fallback, model: "system" });
    throw new Error("Setti's reply did not pass verification against this project's records, so nothing was saved. Retry, or rephrase the request.");
  } catch (error) {
    // Never persist API error bodies, secrets, SQL, or upstream request headers; the server log keeps the cause for diagnosis.
    if (process.env.NODE_ENV !== "test") console.error("Setti reply failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "unknown error");
    let userError = "The AI request or result validation failed, so the draft was not updated. Check the model configuration and network, then retry.";
    if (error instanceof Error && !error.message.match(/(?:api[_ -]?key|bearer|sk-ant-|select |insert |postgres|password)/iu)) {
      if (/^(The approved version for this project|This project's context|This test version|The model API is not configured|The model did not return|Only your own @Setti|Setti's reply did not pass verification)/u.test(error.message)) userError = error.message;
    }
    await store.failAi(sessionId, key, messageId, runId, userError);
    throw new CaseAiError(userError);
  }
}

export class CaseAiError extends Error {}
