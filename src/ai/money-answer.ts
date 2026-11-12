import { MONEY_STATUS_LABEL, type MoneyAnswer, type MoneyAnswerDraft, type MoneyAnswerSentence, type MoneyContext, type MoneyItem, type MoneyTableRow } from "./money-types";
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
/** What a sentence is about when it speaks of the project as a whole rather than one item. */
export const PROJECT = "project";

/** The facts no item owns: totals, the budget, the approval and warnings about the whole project. */
function projectFactIds(context: MoneyContext): string[] {
  const owned = new Set((context.items ?? []).flatMap((item) => item.factIds));
  return context.facts.map((fact) => fact.id).filter((id) => !owned.has(id));
}

/** Everything a sentence may rest on: the facts it cites, and every record of the items (or the project) it is about. */
export function sentenceEvidence(context: MoneyContext, sentence: MoneyAnswerSentence): string[] {
  const items = new Map((context.items ?? []).map((item) => [item.key, item]));
  const ids = [...sentence.factIds];
  for (const key of sentence.about ?? []) ids.push(...(key === PROJECT ? projectFactIds(context) : items.get(key)?.factIds ?? []));
  return [...new Set(ids)];
}

/** The written parts of an answer, named as the model will read them back. */
function draftParts(draft: MoneyAnswerDraft): { name: string; sentence: MoneyAnswerSentence }[] {
  return [{ name: "The summary", sentence: draft.summary }, ...draft.notes.map((note, index) => ({ name: `Note ${index + 1}`, sentence: note }))];
}

/** Every fact the answer rests on, each once: its sentences' evidence, then its table items' records. */
export function answerFactIds(context: MoneyContext, draft: MoneyAnswerDraft): string[] {
  const items = new Map((context.items ?? []).map((item) => [item.key, item]));
  return [...new Set([...draftParts(draft).flatMap((part) => sentenceEvidence(context, part.sentence)), ...draft.items.flatMap((key) => items.get(key)?.factIds ?? [])])];
}

/** The answer as plain text, for chat previews and anywhere the layout cannot be shown. */
export function answerText(draft: MoneyAnswerDraft, table: readonly MoneyTableRow[]): string {
  return [draft.summary.text, ...table.map((row) => `${row.label}: ${MONEY_STATUS_LABEL[row.status]} · net ${usd(row.netCents)}`), ...draft.notes.map((note) => note.text)].map((line) => line.trim()).join("\n");
}

/**
 * Checks Setti's written money answer against the records before it is saved.
 * The item table is built from the records, so only the items it lists are
 * checked there. Each sentence is checked against the facts it cites and every
 * record of what it is about: each amount must be written in those records, and
 * each charge, refund, hold, release, credit or pending result must be recorded
 * there. Recorded warnings must be addressed. Returns what to fix.
 */
export function verifyMoneyAnswer(context: MoneyContext, draft: MoneyAnswerDraft): string[] {
  const facts = new Map(context.facts.map((fact) => [fact.id, fact.text.en]));
  const items = new Map((context.items ?? []).map((item) => [item.key, item]));
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const key of draft.items) {
    if (!items.has(key)) problems.push(`items lists "${key}", which is not a key in moneyEvidence.items.`);
    else if (listed.has(key)) problems.push(`items lists "${key}" twice.`);
    listed.add(key);
  }
  const cited = new Set<string>();
  for (const { name, sentence } of draftParts(draft)) {
    const label = `${name} ("${sentence.text.slice(0, 80)}")`;
    const unknown = sentence.factIds.filter((id) => !facts.has(id));
    if (unknown.length) problems.push(`${label} cites facts that are not in moneyEvidence: ${unknown.join(", ")}.`);
    const strange = (sentence.about ?? []).filter((key) => key !== PROJECT && !items.has(key));
    if (strange.length) problems.push(`${label} is about ${strange.map((key) => `"${key}"`).join(", ")}, not in moneyEvidence.items; use item keys or "${PROJECT}".`);
    for (const id of sentence.factIds) cited.add(id);
    if (EAST_ASIAN_SCRIPT.test(sentence.text)) problems.push(`${label} is not in English.`);
    if (/https?:\/\//iu.test(sentence.text)) problems.push(`${label} contains a link; the server adds the evidence links.`);
    if (ACTION_CLAIM.test(sentence.text)) problems.push(`${label} says the AI performed a payment action; the AI cannot move money or approve anything.`);
    const texts = sentenceEvidence(context, sentence).flatMap((id) => facts.get(id) ?? []);
    const amounts = amountsIn(sentence.text);
    const terms = STATUS_TERMS.filter((term) => term.said.test(sentence.text));
    if (!texts.length) {
      if (amounts.length || terms.length) problems.push(`${label} states an amount or payment status, but names nothing in about and cites no fact.`);
      continue;
    }
    const scope = scopeOf(sentence, items);
    const recorded = [...new Set(texts.flatMap(amountsIn))];
    const missing = amounts.filter((amount) => !recorded.includes(amount));
    if (missing.length) problems.push(`${label} uses ${missing.map(usd).join(", ")}, which is not written in the records of ${scope}; those records contain ${recorded.slice(0, 20).map(usd).join(", ") || "no amounts"}. Use only those amounts, never a sum or difference of them; if the amount belongs to another item, add that item to about.`);
    for (const term of terms) if (!texts.some((text) => term.recorded.test(text))) problems.push(`${label} mentions ${term.name}, but the records of ${scope} do not record one. If it belongs to another item, add that item to about; otherwise do not say it.`);
  }
  const unaddressed = (context.mandatoryFactIds ?? []).filter((id) => !SHOWN_ANYWAY.has(id) && facts.has(id) && !cited.has(id));
  if (unaddressed.length) problems.push(`The answer must address these recorded warnings and list them in the factIds of the sentence that does: ${unaddressed.join(", ")}.`);
  return problems;
}

/** How a problem names what a sentence is about, in the item names the model was given. */
function scopeOf(sentence: MoneyAnswerSentence, items: ReadonlyMap<string, MoneyItem>): string {
  const names = (sentence.about ?? []).map((key) => key === PROJECT ? "the project" : items.get(key)?.label).filter(Boolean);
  return names.length ? `${names.join(", ")}${sentence.factIds.length ? " and the facts it cites" : ""}` : "the facts it cites";
}

/** Shown, as a system notice, when Setti's written answer did not pass verification twice. */
export const UNVERIFIED_MONEY_TEXT = "Setti's written answer did not pass verification against the saved records, so it was not shown. These are the recorded facts it selected.";
/** The same notice when the item table, which comes from the records, is still shown. */
export const UNVERIFIED_MONEY_TABLE_TEXT = "Setti's written explanation did not pass verification against the saved records, so it was not shown. The table comes straight from the records.";

const sentenceOf = (sentence: MoneyAnswerSentence): MoneyAnswerSentence => ({
  text: sentence.text.trim(), factIds: [...new Set(sentence.factIds)], ...(sentence.about?.length ? { about: [...new Set(sentence.about)] } : {}),
});

/**
 * The facts and evidence behind an answer; amounts, statuses, sources and URLs
 * all come from the records. `tableKeys` are the items to tabulate, from the
 * records as they are now, so the saved table never changes afterwards.
 */
export function buildMoneyAnswer(context: MoneyContext, selected: readonly string[], draft?: MoneyAnswerDraft, showEvidence = false, tableKeys: readonly string[] = draft?.items ?? []): { text: string; moneyAnswer: MoneyAnswer } {
  // Every selected fact comes from the bounded money context, so an answer may cite as many of them as it needs.
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error("Invalid money fact selection");
  const items = new Map((context.items ?? []).map((item) => [item.key, item]));
  const table = [...new Set(tableKeys)].flatMap((key) => { const item = items.get(key); return item ? [structuredClone(item)] : []; });
  const byId = new Map(context.facts.map((fact) => [fact.id, fact]));
  const bySource = new Map(context.sources.map((source) => [source.id, source]));
  const ids = [...new Set([...(draft ? answerFactIds(context, draft) : []), ...selected, ...table.flatMap((row) => row.factIds), ...(context.mandatoryFactIds ?? [])])].filter((id) => byId.has(id) || selected.includes(id));
  const facts = ids.map((id) => {
    const fact = byId.get(id);
    if (!fact || !fact.sourceIds.length || fact.sourceIds.some((source) => !bySource.has(source))) throw new Error("Unknown money evidence");
    return structuredClone(fact);
  });
  const sources = context.sources.filter((source) => facts.some((fact) => fact.sourceIds.includes(source.id)));
  // A project's quote, optionally one version of it; answers saved before versions moved there link to /change-orders.
  if (sources.some((source) => !/^\/(?:quotes\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\?v=[1-9]\d{0,3})?|change-orders\/[0-9a-f-]{36})(?:#[a-zA-Z0-9_%.-]+)?$/.test(source.href))) throw new Error("Invalid money source");
  return {
    text: draft ? answerText(draft, table) : table.length ? UNVERIFIED_MONEY_TABLE_TEXT : UNVERIFIED_MONEY_TEXT,
    moneyAnswer: {
      quoteId: context.quoteId, version: context.version, checkedAt: context.checkedAt,
      providerRecordedAt: context.providerRecordedAt, mode: context.mode, facts, sources: structuredClone(sources),
      ...(table.length ? { table } : {}),
      ...(draft ? { answer: { summary: sentenceOf(draft.summary), rows: [], notes: draft.notes.map(sentenceOf) }, showEvidence } : {}),
    },
  };
}
