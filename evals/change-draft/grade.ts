/** Grades one change-draft run against its case's answer key, from what Setti actually saved. */
import type { ApprovedQuoteReport } from "@/quotes/types";
import type { CaseMessage, ChangeDraft, ProductPage } from "@/chat/types";
import type { DraftCase, ExpectedChange } from "./cases";

export interface Attempt {
  n: number;
  /** The verification problems sent back with this attempt, if it was a rewrite. */
  problems: string[] | null;
  kind: "ok" | "refusal" | "error" | "timeout";
  output: unknown;
  model: string | null;
  usage: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number } | null;
  /** List-price API cost of the call as the model provider reports it. */
  costUsd: number;
  durationMs: number;
  message?: string;
  /** Identifies the request, so a recorded answer is replayed only for the same request. */
  fingerprint?: string;
}

export interface RunOutcome {
  completed?: { text: string; draft?: ChangeDraft | null; model: string };
  failed?: string;
  attempts: Attempt[];
}

export type OutcomeKind = "draft" | "no_draft" | "cancel" | "fallback" | "refused_context" | "error";

export interface Grade {
  scores: { pass: number; change_recall: number; change_precision: number; first_try: number; invented_ids: number };
  outcome: OutcomeKind;
  intent: string | null;
  refused: boolean;
  violations: string[];
  explanation: string;
}

const CONTEXT_REFUSAL = /^This project's context exceeds/u;

export function outcomeOf(run: RunOutcome): OutcomeKind {
  if (run.failed !== undefined) return CONTEXT_REFUSAL.test(run.failed) && run.attempts.length === 0 ? "refused_context" : "error";
  const done = run.completed!;
  if (done.model === "system") return "fallback";
  if (done.draft === null) return "cancel";
  return done.draft ? "draft" : "no_draft";
}

const keyOf = (change: ExpectedChange) => [change.action, change.itemId ?? "-", change.action === "remove" ? "" : String(change.quantity ?? ""), change.productOptionId ?? ""].join("|");

/** The change a saved draft line represents, in answer-key form. */
export function asExpected(change: ChangeDraft["changes"][number]): ExpectedChange {
  return {
    action: change.action, itemId: change.itemId,
    ...(change.action === "remove" ? {} : { quantity: change.after?.quantity }),
    ...(change.productOptionId ? { productOptionId: change.productOptionId } : {}),
  };
}

interface RawChange { action?: string; itemId?: string | null; productOptionId?: string | null; sourceMessageIds?: string[] }

/** Ids a raw model output used that do not exist in the case, before any server check removed them. */
export function inventedIds(attempts: Attempt[], quote: ApprovedQuoteReport, pages: ProductPage[], messages: CaseMessage[]): string[] {
  const items = new Set(quote.lines.map((line) => line.itemId));
  const options = new Set(pages.flatMap((page) => page.products.map((product) => product.id)));
  const humans = new Set(messages.filter((message) => message.actor !== "assistant").map((message) => message.id));
  const invented: string[] = [];
  for (const attempt of attempts) {
    const changes = (attempt.output as { changes?: RawChange[] } | null)?.changes ?? [];
    for (const change of changes) {
      if (change.itemId && !items.has(change.itemId)) invented.push(`item ${change.itemId}`);
      if (change.productOptionId && !options.has(change.productOptionId)) invented.push(`product ${change.productOptionId}`);
      for (const id of change.sourceMessageIds ?? []) if (!humans.has(id)) invented.push(`message ${id}`);
    }
  }
  return invented;
}

export function grade(testCase: DraftCase, run: RunOutcome, quote: ApprovedQuoteReport, pages: ProductPage[], messages: CaseMessage[]): Grade {
  const expected = testCase.expected;
  const outcome = outcomeOf(run);
  const last = [...run.attempts].reverse().find((attempt) => attempt.kind === "ok");
  const intent = (last?.output as { intent?: string } | undefined)?.intent ?? null;
  const refused = run.attempts.some((attempt) => attempt.kind === "refusal");
  const violations: string[] = [];

  const actual = outcome === "draft" ? run.completed!.draft!.changes.map(asExpected) : [];
  const actualKeys = actual.map(keyOf);
  // A case may accept more than one right change set; grade against the closest.
  const candidates = [expected.changes ?? [], ...(expected.alternatives ?? [])];
  const scored = candidates.map((set) => ({ set, matched: actualKeys.filter((key) => new Set(set.map(keyOf)).has(key)).length }));
  const best = scored.find((entry) => entry.matched === entry.set.length && actual.length === entry.set.length)
    ?? scored.reduce((top, entry) => entry.matched - entry.set.length > top.matched - top.set.length ? entry : top);
  const wanted = best.set;
  const wantedKeys = new Set(wanted.map(keyOf));
  const matched = best.matched;
  const recall = wanted.length ? matched / wanted.length : 1;
  const precision = actual.length ? matched / actual.length : wanted.length ? 0 : 1;

  for (const change of actual) {
    if (change.itemId && expected.forbiddenItemIds?.includes(change.itemId)) violations.push(`changed ${change.itemId}`);
    if (change.productOptionId && expected.forbiddenOptionIds?.includes(change.productOptionId)) violations.push(`chose ${change.productOptionId}`);
  }
  const written = [run.completed?.text ?? "", run.completed?.draft?.title ?? "", run.completed?.draft?.summary ?? ""].join("\n");
  for (const claim of expected.forbiddenClaims ?? []) {
    const match = new RegExp(claim, "iu").exec(written);
    if (match) violations.push(`wrote "${match[0]}"`);
  }
  for (const claim of expected.requiredClaims ?? []) {
    if (!new RegExp(claim, "iu").test(written)) violations.push(`did not state /${claim}/`);
  }

  let pass = false;
  if (expected.outcome === "refused_context") pass = outcome === "refused_context";
  else if (expected.outcome === "cancel") pass = outcome === "cancel";
  else if (expected.outcome === "no_draft") pass = outcome === "no_draft" && !!intent && (expected.intents ?? []).includes(intent as "answer" | "clarify");
  else pass = outcome === "draft" && matched === wanted.length && actual.length === wanted.length;
  if (violations.length) pass = false;

  const invented = inventedIds(run.attempts, quote, pages, messages);
  const firstTry = run.attempts.length === 1 && run.attempts[0].kind === "ok" && (outcome === "draft" || outcome === "no_draft" || outcome === "cancel") ? 1 : 0;
  const parts = [`outcome ${outcome}${intent ? ` (intent ${intent})` : ""}`, `${run.attempts.length} model call${run.attempts.length === 1 ? "" : "s"}`];
  if (wanted.length || actual.length) parts.push(`changes ${matched}/${wanted.length} expected matched, ${actual.length} drafted`);
  const missing = wanted.map(keyOf).filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter((key) => !wantedKeys.has(key));
  if (missing.length) parts.push(`missing ${missing.join("; ")}`);
  if (extra.length) parts.push(`extra ${extra.join("; ")}`);
  if (violations.length) parts.push(`violations: ${violations.join("; ")}`);
  if (invented.length) parts.push(`invented ids: ${invented.join(", ")}`);
  if (refused) parts.push("a safety refusal ended an attempt");
  if (run.failed) parts.push(`error: ${run.failed.slice(0, 160)}`);
  return {
    scores: { pass: pass ? 1 : 0, change_recall: recall, change_precision: precision, first_try: firstTry, invented_ids: invented.length },
    outcome, intent, refused, violations, explanation: parts.join(" · "),
  };
}
