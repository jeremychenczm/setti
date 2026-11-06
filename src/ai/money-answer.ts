import type { MoneyAnswer, MoneyAnswerBody, MoneyAnswerSentence, MoneyContext } from "./money-types";
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
    || hasPaymentStatusClaim(text);
}

export function hasEastAsianScript(text: string): boolean {
  return EAST_ASIAN_SCRIPT.test(text);
}

/** A payment result stated as fact, separate from amounts: a draft reply may quote prices but never payment results. */
export function hasPaymentStatusClaim(text: string): boolean {
  return /\b(?:unpaid|unrefunded|uncaptured|paid|captured|charged|refunded|held|authorized|authorised|released|credited|collected|debited|voided)\b/iu.test(text)
    // "Settled" also means decided ("the changes we settled"), so it counts only next to money words or as "settled up".
    || /\b(?:payments?|balances?|bills?|invoices?|accounts?|refunds?|charges?|money|funds|deposits?|amounts?|totals?)\b.{0,35}\b(?:un)?settled\b|\b(?:un)?settled\b\s+(?:up\b|in full\b|.{0,25}\b(?:payments?|balances?|bills?|invoices?|accounts?|in paypal)\b)/iu.test(text)
    || /\b(?:payment|refund|money|funds)\b.{0,35}\b(?:received|reached|arrived)\b|\breceived\b.{0,35}\b(?:payment|refund|money|funds)\b/iu.test(text)
    || /(?:already|not yet|no longer|fully|completed|succeeded|still|remaining|has been|have been).{0,35}(?:paid|captur|charg|refund|held|hold|authoriz|releas)|(?:paid|captur|charg|refund|authoriz|releas).{0,35}(?:completed|succeeded|pending|failed|unknown)/iu.test(text);
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Every amount written in the text, in cents: $1,234.56, $1,234, USD 1,234.56 or 1,234.56 USD. Signs are ignored. */
export function amountsIn(text: string): number[] {
  const pattern = /(?:\$|\bUSD\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:USD|dollars?)\b/giu;
  return [...text.matchAll(pattern)].map((match) => {
    const whole = Number((match[1] ?? match[3]).replaceAll(",", ""));
    const fraction = Number((match[2] ?? match[4] ?? "0").padEnd(2, "0"));
    return whole * 100 + fraction;
  });
}

/** What a sentence says happened, and what a cited fact must record for it to say so. */
const STATUS_TERMS = [
  { name: "a charge", said: /\b(?:charg|captur|paid\b|collect)/iu, recorded: /captur|charg/iu },
  { name: "a refund", said: /\brefund/iu, recorded: /refund/iu },
  { name: "a hold", said: /\b(?:held|holds?\b|authori[sz])/iu, recorded: /held|hold|authori[sz]/iu },
  { name: "a release", said: /\b(?:releas|void)/iu, recorded: /releas|void/iu },
  { name: "a supplier credit", said: /\bcredit/iu, recorded: /credit/iu },
  { name: "a pending result", said: /\b(?:pending|unknown|not yet|waiting|awaiting)\b/iu, recorded: /pending|unknown|not yet|has not|wait|remains/iu },
];
const ACTION_CLAIM = /\bI\s+(?:have\s+|just\s+)?(?:refunded|charged|captured|released|paid|approved|moved|sent|authori[sz]ed|voided)\b/iu;
/** Warnings the evidence panel always shows; the written answer need not repeat them. */
const SHOWN_ANYWAY = new Set(["record-freshness", "outside-scope"]);

/** Each part of an answer as one checkable statement, named as the model will read it back. */
function answerParts(body: MoneyAnswerBody): { name: string; text: string; factIds: string[] }[] {
  return [
    { name: "The summary", ...body.summary },
    ...body.rows.map((row, index) => ({ name: `Row ${index + 1}`, text: `${row.label}: ${row.status}${row.amount ? ` ${row.amount}` : ""}`, factIds: row.factIds })),
    ...body.notes.map((note, index) => ({ name: `Note ${index + 1}`, ...note })),
  ];
}

/** Every fact the answer cites, each once, in the order it first cites them. */
export function answerFactIds(body: MoneyAnswerBody): string[] {
  return [...new Set(answerParts(body).flatMap((part) => part.factIds))];
}

/** The answer as plain text, for chat previews and anywhere the layout cannot be shown. */
export function answerText(body: MoneyAnswerBody): string {
  return [body.summary.text, ...body.rows.map((row) => `${row.label}: ${row.status}${row.amount ? ` · ${row.amount}` : ""}`), ...body.notes.map((note) => note.text)].map((line) => line.trim()).join("\n");
}

/**
 * Checks Setti's written money answer against the recorded facts before it is
 * saved: each amount and payment status must come from the facts its part
 * cites, and recorded warnings must be addressed. Returns what to fix.
 */
export function verifyMoneyAnswer(context: MoneyContext, body: MoneyAnswerBody): string[] {
  const facts = new Map(context.facts.map((fact) => [fact.id, fact.text.en]));
  const problems: string[] = [];
  body.rows.forEach((row, index) => {
    if (!row.factIds.length) problems.push(`Row ${index + 1} (${row.label}) must cite the facts it rests on.`);
    if (row.amount !== null && amountsIn(row.amount).length !== 1) problems.push(`Row ${index + 1} (${row.label}) amount must be one amount written like $1,200.00, or null.`);
  });
  const cited = new Set<string>();
  answerParts(body).forEach((sentence) => {
    const label = `${sentence.name} ("${sentence.text.slice(0, 80)}")`;
    const unknown = sentence.factIds.filter((id) => !facts.has(id));
    if (unknown.length) problems.push(`${label} cites facts that are not in moneyEvidence: ${unknown.join(", ")}.`);
    const texts = sentence.factIds.flatMap((id) => facts.get(id) ?? []);
    for (const id of sentence.factIds) cited.add(id);
    if (EAST_ASIAN_SCRIPT.test(sentence.text)) problems.push(`${label} is not in English.`);
    if (/https?:\/\//iu.test(sentence.text)) problems.push(`${label} contains a link; the server adds the evidence links.`);
    if (ACTION_CLAIM.test(sentence.text)) problems.push(`${label} says Setti performed a payment action; Setti cannot move money or approve anything.`);
    const amounts = amountsIn(sentence.text);
    const terms = STATUS_TERMS.filter((term) => term.said.test(sentence.text));
    if ((amounts.length || terms.length) && !texts.length) problems.push(`${label} states an amount or payment status without citing the facts it rests on.`);
    if (!texts.length) return;
    const recorded = new Set(texts.flatMap(amountsIn));
    const missing = amounts.filter((amount) => !recorded.has(amount));
    if (missing.length) problems.push(`${label} uses ${missing.map(usd).join(", ")}, which is not written in the facts it cites. Use only amounts written in those facts; do not add or subtract them.`);
    for (const term of terms) if (!texts.some((text) => term.recorded.test(text))) problems.push(`${label} mentions ${term.name}, but none of the facts it cites records one.`);
  });
  const unaddressed = (context.mandatoryFactIds ?? []).filter((id) => !SHOWN_ANYWAY.has(id) && facts.has(id) && !cited.has(id));
  if (unaddressed.length) problems.push(`The answer must address these recorded warnings and cite them: ${unaddressed.join(", ")}.`);
  return problems;
}

/** Shown, as a system notice, when Setti's written answer did not pass verification twice. */
export const UNVERIFIED_MONEY_TEXT = "Setti's written answer did not pass verification against the saved records, so it was not shown. These are the recorded facts it selected.";

const sentenceOf = (sentence: MoneyAnswerSentence): MoneyAnswerSentence => ({ text: sentence.text.trim(), factIds: [...new Set(sentence.factIds)] });
/** A stored copy with trimmed text and each citation once. */
function cleanAnswer(body: MoneyAnswerBody): MoneyAnswerBody {
  return {
    summary: sentenceOf(body.summary),
    rows: body.rows.map((row) => ({ label: row.label.trim(), status: row.status.trim(), amount: row.amount?.trim() || null, factIds: [...new Set(row.factIds)] })),
    notes: body.notes.map(sentenceOf),
  };
}

/** The facts and evidence behind an answer; amounts, statuses, sources and URLs all come from the records. */
export function buildMoneyAnswer(context: MoneyContext, selected: readonly string[], answer?: MoneyAnswerBody, showEvidence = false): { text: string; moneyAnswer: MoneyAnswer } {
  // Every selected fact comes from the bounded money context, so an answer may cite as many of them as it needs.
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error("Invalid money fact selection");
  const byId = new Map(context.facts.map((fact) => [fact.id, fact]));
  const bySource = new Map(context.sources.map((source) => [source.id, source]));
  const ids = [...new Set([...(answer ? answerParts(answer) : []).flatMap((part) => part.factIds), ...selected, ...(context.mandatoryFactIds ?? [])])];
  const facts = ids.map((id) => {
    const fact = byId.get(id);
    if (!fact || !fact.sourceIds.length || fact.sourceIds.some((source) => !bySource.has(source))) throw new Error("Unknown money evidence");
    return structuredClone(fact);
  });
  const sources = context.sources.filter((source) => facts.some((fact) => fact.sourceIds.includes(source.id)));
  if (sources.some((source) => !/^\/(?:quotes\/(?:maple|willow)|change-orders\/[0-9a-f-]{36})(?:#[a-zA-Z0-9_%.-]+)?$/.test(source.href))) throw new Error("Invalid money source");
  return {
    text: answer ? answerText(answer) : UNVERIFIED_MONEY_TEXT,
    moneyAnswer: {
      quoteId: context.quoteId, version: context.version, checkedAt: context.checkedAt,
      providerRecordedAt: context.providerRecordedAt, mode: context.mode, facts, sources: structuredClone(sources),
      ...(answer ? { answer: cleanAnswer(answer), showEvidence } : {}),
    },
  };
}
