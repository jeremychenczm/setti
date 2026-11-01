import type { MoneyAnswer, MoneyContext } from "./money-types";
import { aiTask, isExplicitDraftRequest } from "./intent";

/** A hint for deferring irrelevant product reads and protecting clearly read-only questions. */
export function isMoneyQuestion(text: string): boolean {
  if (isExplicitDraftRequest(text)) return false;
  const task = aiTask(text);
  const leadingExplanation = /^(?:(?:please|kindly)\s+)?(?:why|how|what|where|which|when|explain|show|tell|check|summari[sz]e|status)\b/iu;
  const englishChange = /^(?:(?:please|kindly)\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)|(?:(?:i|we)\s+(?:want|would\s+like)\s+(?:you\s+)?to\s+)|(?:let['’]s\s+))?(?:(?:do\s+not|don't)\s+)?(?:replace|swap|change|increase|decrease|remove|return|cancel|add|keep|withdraw|revert)\b/iu;
  // Asking for the price while requesting a change must still allow a review draft.
  // A leading explanation/status question about an earlier change stays read-only.
  if (!leadingExplanation.test(task) && englishChange.test(task)) return false;
  const subject = /budget|pay(?:ment|pal|ments)?|paid|charg|captur|refund|authoriz|hold|held|releas|balance|money|cost/iu;
  const question = /\?|\b(?:why|explain|status|how|what|where|which|show|tell|check|summari[sz]e)\b/iu;
  return subject.test(text) && question.test(text);
}

/** East Asian scripts (CJK, kana, Hangul and their full-width punctuation), written as code points. */
const EAST_ASIAN_SCRIPT = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

/**
 * Generic prose cannot bypass the grounded money response channel. Setti
 * writes English; prose in a script these checks cannot read counts as
 * unsupported rather than passing unchecked.
 */
export function hasUnsupportedMoneyClaim(text: string): boolean {
  return EAST_ASIAN_SCRIPT.test(text)
    || /[$€£¥]|\b(?:USD|dollars?|euros?)\b/iu.test(text)
    || /\b(?:unpaid|unrefunded|uncaptured|unsettled|paid|captured|charged|refunded|held|authorized|authorised|released|credited|collected|settled|debited|voided)\b/iu.test(text)
    || /\b(?:payment|refund|money|funds)\b.{0,35}\breceived\b|\breceived\b.{0,35}\b(?:payment|refund|money|funds)\b/iu.test(text)
    || /(?:already|not yet|no longer|fully|completed|succeeded|still|remaining|has been|have been).{0,35}(?:paid|captur|charg|refund|held|hold|authoriz|releas)|(?:paid|captur|charg|refund|authoriz|releas).{0,35}(?:completed|succeeded|pending|failed|unknown)/iu.test(text);
}

/** The model selects relevance; it cannot supply amounts, statuses, sources or URLs. */
export function buildMoneyAnswer(context: MoneyContext, selected: readonly string[]): { text: string; moneyAnswer: MoneyAnswer } {
  if (!selected.length || selected.length > 16 || new Set(selected).size !== selected.length) throw new Error("Invalid money fact selection");
  const byId = new Map(context.facts.map((fact) => [fact.id, fact]));
  const bySource = new Map(context.sources.map((source) => [source.id, source]));
  const ids = [...new Set([...selected, ...(context.mandatoryFactIds ?? [])])];
  const facts = ids.map((id) => {
    const fact = byId.get(id);
    if (!fact || !fact.sourceIds.length || fact.sourceIds.some((source) => !bySource.has(source))) throw new Error("Unknown money evidence");
    return structuredClone(fact);
  });
  const sources = context.sources.filter((source) => facts.some((fact) => fact.sourceIds.includes(source.id)));
  if (sources.some((source) => !/^\/(?:quotes\/(?:maple|willow)|change-orders\/[0-9a-f-]{36})(?:#[a-zA-Z0-9_%.-]+)?$/.test(source.href))) throw new Error("Invalid money source");
  return {
    text: "Here is the evidence relevant to your question from this project's recorded approvals and payments.",
    moneyAnswer: {
      quoteId: context.quoteId, version: context.version, checkedAt: context.checkedAt,
      providerRecordedAt: context.providerRecordedAt, mode: context.mode, facts, sources: structuredClone(sources),
    },
  };
}
