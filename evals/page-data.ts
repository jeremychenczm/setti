/**
 * Writes the AI quality page's data (src/ui/ai-quality/eval-data.json) from the
 * eval cases and the model replies recorded in evals/recorded/. It calls no model
 * and grades nothing itself: each run's result is the one recorded with it.
 *
 *   npm run eval:page
 *
 * Run it again after recording new answers, and commit the data with them.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseMessage, ProductOption, ProductPage } from "@/chat/types";
import { HOME_EVIDENCE_PAGE, isHomeQuote } from "@/demo/home-evidence";
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { EvalCase, EvalFlow, EvalLine, EvalPlanted, EvalReply, EvalRun } from "@/ui/ai-quality/types";
import { CASES as DRAFT_CASES, type DraftCase, type ExpectedChange } from "./change-draft/cases";
import { BENCH_URL, HEX_URL, ORB_URL, RUG_URL, SOFA_URL, benchPage, harborQuote, hexPage, orbPage, rugPage, sofaPage } from "./change-draft/harbor-lane";
import { SCENARIOS, truthOf } from "./inbox-summary/scenarios";
import { CASES as MONEY_CASES, type MoneyCase } from "./money-answer/cases";
import { loadRecording, type Flow, type Recording } from "./lib/replay";

const OUT = join(process.cwd(), "src", "ui", "ai-quality", "eval-data.json");
const REPO = "https://github.com/jeremychenczm/setti/blob/main/evals";
/** A thread longer than this is described rather than shown. */
const SHOWN_MESSAGES = 24;
const SHOWN_CHARS = 12_000;

if (!existsSync(join(process.cwd(), "evals", "recorded"))) throw new Error("Run this from the setti-app directory.");

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quoted = (text: string) => `“${text}”`;
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const orList = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
const who = (actor: CaseMessage["actor"]) => actor === "assistant" ? "Coordinator" : actor[0].toUpperCase() + actor.slice(1);

function recording(flow: Flow, id: string): Recording {
  const found = loadRecording(flow, id);
  if (!found) throw new Error(`No recording for ${flow}/${id}. Record it with the api backend first.`);
  return found;
}

/**
 * The plain phrases a pattern accepts, when it is a list of phrases: `\bnot yet|\bpending\b`
 * gives ["not yet", "pending"]. A group of choices, optional or not, keeps its first
 * choice. Null when the pattern is more than a list of phrases.
 */
function phrasesOf(pattern: string): string[] | null {
  const top: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") { i++; continue; }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "|" && depth === 0) { top.push(pattern.slice(start, i)); start = i + 1; }
  }
  top.push(pattern.slice(start));
  const phrases = top.map((alternative) => {
    let text = alternative.replace(/\(\?:([^()|]*)(?:\|[^()]*)?\)\??/gu, "$1").replace(/\\b/gu, "").replace(/\\s\+/gu, " ");
    if (/[[\]{}*+?^$()]/u.test(text.replace(/\\./gu, ""))) return null;
    text = text.replace(/\\(.)/gu, "$1").replace(/\s+/gu, " ").trim();
    return text || null;
  });
  return phrases.every((phrase): phrase is string => phrase !== null) ? [...new Set(phrases)] : null;
}

function mustSay(pattern: string): { key: string; check: string } {
  const phrases = phrasesOf(pattern);
  if (!phrases) return { key: `Must match /${pattern}/`, check: `Matched /${pattern}/` };
  const shown = phrases.slice(0, 3).map(quoted);
  const more = phrases.length > 3 ? " or a similar phrase" : "";
  return { key: `Must say ${orList(shown)}${more}`, check: `Said ${orList(shown)}${more}` };
}

// ---- change drafts ----

const BASE_PAGES: Record<string, () => ProductPage> = { [SOFA_URL]: () => sofaPage(), [BENCH_URL]: () => benchPage(), [HEX_URL]: () => hexPage(), [ORB_URL]: () => orbPage(), [RUG_URL]: () => rugPage() };
const trimPlanted = (text: string) => text.replace(/^[\s.]+/u, "").trim();
const added = (before: string, after: string) => after.startsWith(before) ? trimPlanted(after.slice(before.length)) : after;

/** Instructions an injection case hides in a supplier page or the quote: what differs from the clean page or quote. */
function plantedIn(testCase: DraftCase, quote: ApprovedQuoteReport, pages: ProductPage[]): EvalPlanted[] {
  if (!testCase.tags.includes("injection")) return [];
  const planted: EvalPlanted[] = [];
  for (const casePage of pages) {
    const base = BASE_PAGES[casePage.url]?.();
    if (!base) continue;
    if (casePage.text !== base.text) planted.push({ where: `Supplier page ${quoted(casePage.title)}`, text: added(base.text, casePage.text) });
    for (const product of casePage.products) {
      const before = base.products.find((entry) => entry.id === product.id);
      if (before && before.specification !== product.specification) planted.push({ where: `Product specification of ${product.name}`, text: added(before.specification, product.specification) });
    }
  }
  if (quote.projectId === harborQuote().projectId) {
    const base = new Map(harborQuote().lines.map((line) => [line.itemId, line]));
    for (const line of quote.lines) {
      const before = base.get(line.itemId);
      if (!before) continue;
      if (before.specification !== line.specification) planted.push({ where: `Quote line ${quoted(line.name)}, specification`, text: added(before.specification, line.specification) });
      if (before.returnPolicy !== line.returnPolicy) planted.push({ where: `Quote line ${quoted(line.name)}, return terms`, text: line.returnPolicy });
    }
  }
  return planted;
}

function namer(quote: ApprovedQuoteReport, options: ProductOption[]) {
  const counts = new Map<string, number>();
  for (const line of quote.lines) counts.set(line.name, (counts.get(line.name) ?? 0) + 1);
  const item = (itemId: string | null) => {
    const line = quote.lines.find((entry) => entry.itemId === itemId);
    if (!line) return itemId ?? "a new line";
    return (counts.get(line.name) ?? 0) > 1 ? `${line.name} (${line.room})` : line.name;
  };
  // An option a case's own pages do not list (a forbidden one, say) is named from the clean supplier pages.
  const known = [...options, ...Object.values(BASE_PAGES).flatMap((page) => page().products).filter((entry) => !options.some((own) => own.id === entry.id))];
  const option = (optionId: string | undefined) => {
    const found = known.find((entry) => entry.id === optionId);
    if (!found) return optionId ?? "";
    // Two options with one name differ by their last specification detail, usually the size.
    return known.some((entry) => entry.id !== found.id && entry.name === found.name) ? `${found.name} (${found.specification.split(" · ").at(-1)})` : found.name;
  };
  const quantityOf = (itemId: string | null) => quote.lines.find((entry) => entry.itemId === itemId)?.quantity ?? null;
  return { item, option, quantityOf };
}

function describeChange(change: ExpectedChange, names: ReturnType<typeof namer>): string {
  const times = change.quantity && change.quantity !== 1 ? ` × ${change.quantity}` : "";
  if (change.action === "remove") return `Remove ${names.item(change.itemId)}`;
  if (change.action === "quantity") return `${names.item(change.itemId)}: ${names.quantityOf(change.itemId) ?? "?"} → ${change.quantity}`;
  if (change.action === "replace") return `Replace ${names.item(change.itemId)} with ${names.option(change.productOptionId)}${times}`;
  return change.productOptionId ? `Add ${names.option(change.productOptionId)}${times}` : `Add a new line${times}, with no supplier page yet`;
}

function draftKeyAndChecks(testCase: DraftCase, names: ReturnType<typeof namer>): { key: string[]; checks: string[] } {
  const expected = testCase.expected;
  const key: string[] = [];
  const checks: string[] = [];
  if (expected.outcome === "draft") {
    key.push(`Draft exactly: ${(expected.changes ?? []).map((change) => describeChange(change, names)).join("; ")}`);
    for (const set of expected.alternatives ?? []) key.push(`Also right: ${set.map((change) => describeChange(change, names)).join("; ")}`);
    checks.push("The draft matched the answer key: nothing missing, nothing extra");
  } else if (expected.outcome === "no_draft") {
    const intents = expected.intents ?? [];
    const words = intents.map((intent) => intent === "clarify" ? "ask which one is meant" : "answer");
    key.push(`No draft: ${orList(words)}`);
    checks.push(`Made no draft and ${intents.length > 1 ? "answered or asked" : intents[0] === "clarify" ? "asked which one was meant" : "answered"}`);
  } else if (expected.outcome === "cancel") {
    key.push("Withdraw the open draft and keep V1");
    checks.push("Withdrew the draft");
  } else {
    key.push("Refuse before calling the model: the project is over the context limit");
    checks.push("Refused before any model call");
  }
  if (expected.forbiddenItemIds?.length) {
    const items = expected.forbiddenItemIds.map(names.item);
    key.push(`Must not change ${list(items)}`);
    checks.push(`Left ${list(items)} unchanged`);
  }
  if (expected.forbiddenOptionIds?.length) {
    const options = expected.forbiddenOptionIds.map((id) => names.option(id));
    key.push(`Must not choose ${orList(options)}`);
    checks.push(`Did not choose ${orList(options)}`);
  }
  for (const claim of expected.forbiddenClaims ?? []) {
    const phrases = phrasesOf(claim);
    if (phrases && phrases.every((phrase) => /^[A-Za-z]+$/u.test(phrase))) {
      key.push(`Must not write ${orList(phrases)}, names from its instructions`);
      checks.push("Wrote none of its instruction names");
    } else {
      key.push("Must not claim a refund, payment or client approval happened");
      checks.push("Claimed no refund, payment or approval");
    }
  }
  for (const claim of expected.requiredClaims ?? []) {
    const said = mustSay(claim);
    key.push(said.key);
    checks.push(said.check);
  }
  return { key, checks };
}

function draftReply(output: unknown): EvalReply {
  const value = output as { message?: string; changes?: { description?: string }[] } | null;
  const changes = (value?.changes ?? []).map((change) => change.description ?? "").filter(Boolean);
  return { text: value?.message ?? null, listLabel: changes.length ? "Draft" : null, list: changes, notes: [], cited: [] };
}

function threadOf(messages: CaseMessage[]): { asked: EvalLine; earlier: EvalLine[]; earlierNote: string | null } {
  const trigger = messages.at(-1)!;
  const before = messages.slice(0, -1);
  const chars = before.reduce((sum, message) => sum + message.text.length, 0);
  const long = before.length > SHOWN_MESSAGES || chars > SHOWN_CHARS;
  return {
    asked: { who: who(trigger.actor), text: trigger.text },
    earlier: long ? [] : before.map((message) => ({ who: who(message.actor), text: message.text })),
    earlierNote: long ? `${before.length} earlier messages, ${chars.toLocaleString("en-US")} characters` : null,
  };
}

function runsOf(flow: Flow, id: string, render: (output: unknown) => EvalReply): EvalRun[] {
  return recording(flow, id).runs.map((run) => {
    const attempts = run.attempts as { output: unknown; problems?: string[] }[];
    return {
      pass: run.pass === 1,
      noModelCall: attempts.length === 0,
      blocked: attempts.slice(0, -1).map((attempt, index) => ({ reply: render(attempt.output), reason: attempts[index + 1]?.problems?.join(" ") ?? attempt.problems?.join(" ") ?? null })),
      reply: attempts.length ? render(attempts.at(-1)!.output) : null,
    };
  });
}

function draftCase(testCase: DraftCase): EvalCase {
  const quote = testCase.quote();
  const messages = testCase.messages();
  const pages = testCase.pages?.() ?? [];
  const options = [...pages, ...(isHomeQuote(quote) ? [HOME_EVIDENCE_PAGE("2026-11-05T00:00:00.000Z")] : [])].flatMap((page) => page.products);
  const names = namer(quote, options);
  const rooms = new Set(quote.lines.map((line) => line.room)).size;
  const given = [`${quote.projectName}: approved quote with ${quote.lines.length} lines in ${rooms} room${rooms === 1 ? "" : "s"}`];
  for (const page of pages) given.push(`Supplier page: ${page.title}`);
  if (testCase.current) {
    const draft = testCase.current(quote, messages);
    given.push(`An open draft, ${quoted(draft.title)}, with ${draft.changes.length} change${draft.changes.length === 1 ? "" : "s"}`);
  }
  const { key, checks } = draftKeyAndChecks(testCase, names);
  return {
    id: testCase.id, group: testCase.tags[0], title: testCase.title,
    ...threadOf(messages), given, planted: plantedIn(testCase, quote, pages), records: null, key, checks,
    runs: runsOf("change-draft", testCase.id, draftReply),
    caseFile: `${REPO}/change-draft/cases.ts`, recordedFile: `${REPO}/recorded/change-draft/${testCase.id}.json`,
  };
}

// ---- money answers ----

function moneyReply(output: unknown): EvalReply {
  const value = output as { message?: string; money?: { answer?: { rows?: { label: string; status: string; amount: string | null; factIds: string[] }[]; notes?: { text: string; factIds: string[] }[]; summary?: { factIds: string[] } } } | null } | null;
  const answer = value?.money?.answer;
  const rows = answer?.rows ?? [];
  const cited = [...new Set([...(answer?.summary?.factIds ?? []), ...rows.flatMap((row) => row.factIds), ...(answer?.notes ?? []).flatMap((note) => note.factIds)])];
  return {
    text: value?.message ?? null, listLabel: null,
    list: rows.map((row) => `${row.label}: ${row.status}${row.amount && row.amount !== "$0.00" ? ` (${row.amount})` : ""}`),
    notes: (answer?.notes ?? []).map((note) => note.text), cited,
  };
}

function moneyCase(testCase: MoneyCase): EvalCase {
  const { quote, moneyContext } = testCase.fixture();
  const expected = testCase.expected;
  const key: string[] = [];
  const checks: string[] = [];
  for (const claim of expected.requiredClaims ?? []) { const said = mustSay(claim); key.push(said.key); checks.push(said.check); }
  if (expected.forbiddenClaims?.length) { key.push("Must not claim a refund or charge the records do not show"); checks.push("Claimed no refund or charge the records do not show"); }
  if (expected.mustCite?.length) { key.push(`Must cite ${list(expected.mustCite)}`); checks.push(`Cited ${list(expected.mustCite)}`); }
  if (expected.showEvidence !== undefined) { key.push(expected.showEvidence ? "Must open the payment records, as asked" : "Must not open the payment records unasked"); checks.push(expected.showEvidence ? "Opened the payment records" : "Kept the payment records closed"); }
  if (expected.minRows) { key.push(`Must list at least ${expected.minRows} items`); checks.push(`Listed at least ${expected.minRows} items`); }
  checks.push("Every amount and status matched the records (Setti's server check)");
  const facts = moneyContext.facts;
  return {
    id: testCase.id, group: testCase.tags[0], title: testCase.title,
    ...threadOf(testCase.messages()),
    given: [`${quote.projectName}, V${quote.version} quote, with payment records captured from a PayPal Sandbox walkthrough`],
    planted: [],
    records: { label: `${facts.length} payment facts it could cite`, rows: facts.map((fact) => [fact.id, fact.text.en]) },
    key, checks,
    runs: runsOf("money-answer", testCase.id, moneyReply),
    caseFile: `${REPO}/money-answer/cases.ts`, recordedFile: `${REPO}/recorded/money-answer/${testCase.id}.json`,
  };
}

// ---- inbox summaries ----

const EVENT_WORDS = { held: "held", charged: "charged", released: "hold released", refunded: "refunded" } as const;

function inboxReply(output: unknown): EvalReply {
  const sentences = (output as { text: string }[] | null) ?? [];
  return { text: null, listLabel: null, list: sentences.map((sentence) => sentence.text), notes: [], cited: [] };
}

function inboxCase(scenario: (typeof SCENARIOS)[number]): EvalCase {
  const timeline = scenario.timeline();
  const truth = truthOf(timeline);
  const held = truth.items.filter((item) => item.heldCents > 0);
  const events = [...timeline.events].sort((a, b) => a.at.localeCompare(b.at));
  return {
    id: scenario.id, group: null, title: scenario.title,
    asked: { who: "Client", text: "Opens their inbox, which starts with a short summary of the project's payments." },
    earlier: [], earlierNote: null,
    given: ["The project's PayPal results as the inbox reads them"],
    planted: [],
    records: { label: `${events.length} payment events`, rows: events.map((event) => [event.at.slice(5, 16).replace("T", " "), `${event.itemLabel} ${EVENT_WORDS[event.kind]}`, usd(event.amountCents)]) },
    key: [
      `On hold now: ${usd(truth.heldCents)}${held.length ? ` (${held.map((item) => `${item.label} ${usd(item.heldCents)}`).join(", ")})` : ""}`,
      "Any sentence that puts something else on hold now fails",
    ],
    checks: ["Put nothing else on hold now", "Every amount matched the inbox records (Setti's server check)"],
    runs: runsOf("inbox-summary", scenario.id, inboxReply),
    caseFile: `${REPO}/inbox-summary/scenarios.ts`, recordedFile: `${REPO}/recorded/inbox-summary/${scenario.id}.json`,
  };
}

function sources(flow: Flow, ids: string[]): string[] {
  return [...new Set(ids.map((id) => recording(flow, id).source))];
}

const flows: EvalFlow[] = [
  { id: "change-draft", title: "Change drafts", summary: "A project chat ends with a request to the Coordinator, which drafts a revised quote for the designer to review.", sources: sources("change-draft", DRAFT_CASES.map((entry) => entry.id)), cases: DRAFT_CASES.map(draftCase) },
  { id: "money-answer", title: "Money answers", summary: "A client asks about payments in the Maple demo project. The answer must match the recorded PayPal Sandbox payments.", sources: sources("money-answer", MONEY_CASES.map((entry) => entry.id)), cases: MONEY_CASES.map(moneyCase) },
  { id: "inbox-summary", title: "Inbox summaries", summary: "A client's inbox opens with a short summary of what has been charged, what is on hold and what was refunded.", sources: sources("inbox-summary", SCENARIOS.map((entry) => entry.id)), cases: SCENARIOS.map(inboxCase) },
];

writeFileSync(OUT, `${JSON.stringify({ flows }, null, 2)}\n`);
const runs = flows.flatMap((flow) => flow.cases.flatMap((entry) => entry.runs));
console.log(`Wrote ${OUT}: ${flows.reduce((sum, flow) => sum + flow.cases.length, 0)} cases, ${runs.length} runs, ${runs.filter((run) => run.pass).length} passed.`);
