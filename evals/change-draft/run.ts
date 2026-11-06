/**
 * Change-draft eval runner. Each case runs through Setti's real entry point,
 * runCaseAi, with an in-memory chat store, the case's supplier pages and a
 * chosen model backend; then it is graded against the answer key.
 *
 *   npx tsx evals/change-draft/run.ts [--backend claude-code|api|oracle|null]
 *     [--cases id,id] [--reps 1] [--stability-reps 3] [--concurrency 3] [--timeout-s 600] [--fresh]
 *
 * Results land in evals/results/change-draft-<backend>/baseline/ (results.jsonl,
 * traces/, errors.jsonl). A rerun skips (case, rep) pairs already graded.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGE_SYSTEM_PROMPT, CONTEXT_CHAR_LIMIT } from "@/ai/model";
import { runCaseAi } from "@/chat/service";
import { HOME_EVIDENCE_PAGE, isHomeQuote } from "@/demo/home-evidence";
import type { ChatStore, StoredCase } from "@/chat/types";
import { backend, type BackendName } from "./backends";
import { CASES, type DraftCase } from "./cases";
import { grade, type RunOutcome } from "./grade";
import { answersFromTrace, loadRecording, replayer, saveRun, type Replayer } from "../lib/replay";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(arg.slice(2), next); i++; } else args.set(arg.slice(2), "true");
}
const backendName = (args.get("backend") ?? "claude-code") as BackendName;
if (!["claude-code", "api", "oracle", "null", "replay"].includes(backendName)) throw new Error(`Unknown backend ${backendName}`);
/** --record saves each graded run's model answers to evals/recorded/; --from-traces <dir> replays a results folder's traces once to record them. */
const recordRuns = args.has("record");
const fromTraces = args.get("from-traces");
const source = args.get("source") ?? `Claude API, ${process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5"}, effort high, ${new Date().toISOString().slice(0, 10)}`;
const replayProblems: string[] = [];
// The api backend calls the model with the server's own key, read from .env.local and never written anywhere.
if (backendName === "api" && existsSync(".env.local")) process.loadEnvFile(".env.local");
const reps = Number(args.get("reps") ?? 1);
const stabilityReps = Number(args.get("stability-reps") ?? 3);
const concurrency = Number(args.get("concurrency") ?? 3);
const timeoutMs = Number(args.get("timeout-s") ?? 600) * 1000;
/** An eval-only context limit, to see how the model copes past the production one; the api backend always uses production's. */
const contextLimit = Number(args.get("context-limit") ?? CONTEXT_CHAR_LIMIT);
const only = args.get("cases")?.split(",").map((id) => id.trim()).filter(Boolean);

// Run from the app root, like the npm scripts.
if (!existsSync(join(process.cwd(), "evals", "change-draft"))) throw new Error("Run this from the setti-app directory.");
const flow = join(process.cwd(), "evals", "results", `change-draft-${backendName}${contextLimit === CONTEXT_CHAR_LIMIT ? "" : `-limit-${contextLimit}`}`);
const out = join(flow, "baseline");
if (args.has("fresh")) rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "traces"), { recursive: true });

const unknown = only?.filter((id) => !CASES.some((entry) => entry.id === id)) ?? [];
if (unknown.length) throw new Error(`Unknown case ids: ${unknown.join(", ")}`);
const selected = CASES.filter((entry) => !only || only.includes(entry.id));

writeFileSync(join(flow, "_state.json"), JSON.stringify({
  metrics: [
    { id: "pass", label: "Pass", kind: "binary" },
    { id: "change_recall", label: "Change recall", kind: "float", scale: 1 },
    { id: "change_precision", label: "Precision", kind: "float", scale: 1 },
    { id: "first_try", label: "First try", kind: "binary" },
    { id: "invented_ids", label: "Invented ids", kind: "float", scale: 10, better: "lower" },
  ],
  perf_fields: [{ id: "cost_usd", label: "API-equiv $" }, { id: "in_tokens", label: "In tokens" }, { id: "out_tokens", label: "Out tokens" }, { id: "latency_s", label: "Latency", unit: "s" }],
  prices: { "claude-sonnet-5-5": { in: 2, out: 10 } },
}, null, 2));

const done = new Set<string>();
const resultsPath = join(out, "results.jsonl");
if (existsSync(resultsPath)) {
  for (const row of readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
    const parsed = JSON.parse(row) as { prompt_id: string; rep: number };
    done.add(`${parsed.prompt_id}#${parsed.rep}`);
  }
}

/** A chat store holding one case in memory; it records what Setti saved. */
function memoryStore(state: StoredCase, outcome: RunOutcome): ChatStore {
  const unsupported = () => { throw new Error("Not used by the eval."); };
  return {
    getCase: async () => state, appendMessage: unsupported, sendQuote: unsupported, getQuote: unsupported,
    beginAi: async () => ({ status: "started", runId: "eval-run", state }),
    reportAiStage: async () => {},
    completeAi: async (_s, _k, _m, _r, result) => { outcome.completed = { text: result.text, draft: result.draft, model: result.model }; return state; },
    failAi: async (_s, _k, _m, _r, error) => { outcome.failed = error; return state; },
  };
}

interface Job { testCase: DraftCase; rep: number }
const repsOf = (testCase: DraftCase) => backendName === "replay" && !fromTraces
  ? (loadRecording("change-draft", testCase.id)?.runs.map((run) => run.rep) ?? [0])
  : Array.from({ length: testCase.stability ? Math.max(reps, stabilityReps) : reps }, (_, rep) => rep);
const jobs: Job[] = selected.flatMap((testCase) => repsOf(testCase).map((rep) => ({ testCase, rep })))
  .filter((job) => !done.has(`${job.testCase.id}#${job.rep}`));

async function runJob({ testCase, rep }: Job): Promise<void> {
  const quote = testCase.quote();
  const messages = testCase.messages();
  const pages = testCase.pages?.() ?? [];
  const current = testCase.current ? testCase.current(quote, messages) : null;
  const trigger = messages.at(-1)!;
  const outcome: RunOutcome = { attempts: [] };
  const recorded = loadRecording("change-draft", testCase.id)?.runs.find((run) => run.rep === rep);
  let replay: Replayer | undefined;
  if (backendName === "replay") {
    replay = fromTraces
      ? replayer({ rep, pass: 0, attempts: answersFromTrace(join(fromTraces, "traces", `${testCase.id}_rep${rep}.json`)).map((output) => ({ fingerprint: "", output })) }, { learn: true })
      : replayer(recorded);
  }
  const state: StoredCase = { id: `eval-${testCase.id}`, projectKey: "willow", messages, draft: current, activeMessageId: null, quote };
  const started = Date.now();
  try {
    await runCaseAi(memoryStore(state, outcome), "eval-session", "willow", trigger.id, {
      configured: () => true,
      readPage: async (url) => { const found = pages.find((entry) => entry.url === url); if (!found) throw new Error("This page is not part of the eval case."); return structuredClone(found); },
      callModel: backend(backendName, testCase, (attempt) => outcome.attempts.push(attempt), { timeoutMs, contextLimit, replay }),
    });
  } catch { /* the outcome records what Setti saved or reported */ }
  const wallMs = Date.now() - started;

  const infra = outcome.attempts.find((attempt) => attempt.kind === "error" || attempt.kind === "timeout");
  const trace = [
    { role: "system", content: CHANGE_SYSTEM_PROMPT },
    ...outcome.attempts.flatMap((attempt) => [
      { role: "user", content: attempt.n === 1 ? `[Project context: quote ${quote.lines.length} lines, ${messages.length} messages, ${pages.length} pages; see the case file.]` : `previousAttemptProblems:\n${(attempt.problems ?? []).join("\n")}` },
      { role: "assistant", content: attempt.output ? JSON.stringify(attempt.output, null, 2) : `[${attempt.kind}] ${attempt.message ?? ""}` },
    ]),
    { role: "assistant", content: `Saved by Setti: ${JSON.stringify(outcome.completed ?? { failed: outcome.failed }, null, 2).slice(0, 20_000)}` },
  ];
  writeFileSync(join(out, "traces", `${testCase.id}_rep${rep}.json`), JSON.stringify(trace, null, 2));

  const usage = outcome.attempts.reduce((sum, attempt) => ({
    input_tokens: sum.input_tokens + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.cacheReadTokens ?? 0) + (attempt.usage?.cacheWriteTokens ?? 0),
    output_tokens: sum.output_tokens + (attempt.usage?.outputTokens ?? 0),
  }), { input_tokens: 0, output_tokens: 0 });
  const costUsd = outcome.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
  const modelSeconds = outcome.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / 1000;

  if (replay?.stale) {
    replayProblems.push(`${testCase.id} #${rep}: stale recording (${replay.stale})`);
    console.log(`  STALE ${testCase.id} #${rep} · ${replay.stale}`);
    return;
  }
  if (infra) {
    appendFileSync(join(out, "errors.jsonl"), `${JSON.stringify({ prompt_id: testCase.id, rep, failure_class: infra.kind, message: infra.message, attempts: outcome.attempts.length, cost_usd: costUsd, at: new Date().toISOString() })}\n`);
    console.log(`  ! ${testCase.id} #${rep}: ${infra.kind} ${infra.message?.slice(0, 120) ?? ""}`);
    return;
  }
  // Setti adds the Maple supplier documents itself; their product ids are real, not invented.
  const graded = grade(testCase, outcome, quote, isHomeQuote(quote) ? [...pages, HOME_EVIDENCE_PAGE()] : pages, messages);
  const row = {
    prompt_id: testCase.id, rep, prompt: `${testCase.title}\n\n${trigger.text}`, tags: testCase.tags,
    status: "ok", stop_reason: graded.outcome, grade: graded.scores, explanation: { pass: graded.explanation },
    model: outcome.attempts.find((attempt) => attempt.model)?.model ?? backendName,
    usage, cost_usd: Number(costUsd.toFixed(4)), in_tokens: usage.input_tokens, out_tokens: usage.output_tokens, latency_s: Number(modelSeconds.toFixed(1)),
    meta: { run_id: randomUUID(), backend: backendName, outcome: graded.outcome, intent: graded.intent, refused: graded.refused, attempts: outcome.attempts.length, violations: graded.violations, twin_of: testCase.twinOf ?? null, wall_s: Math.round(wallMs / 1000), context_limit: contextLimit },
  };
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  if (backendName === "replay" && !fromTraces && recorded && recorded.pass !== graded.scores.pass) replayProblems.push(`${testCase.id} #${rep}: recorded ${recorded.pass ? "PASS" : "FAIL"}, replayed ${graded.scores.pass ? "PASS" : "FAIL"}`);
  if (recordRuns && (backendName === "api" || fromTraces)) {
    saveRun("change-draft", testCase.id, source, { rep, pass: graded.scores.pass, attempts: outcome.attempts.map((attempt) => ({ fingerprint: attempt.fingerprint!, output: attempt.output })) });
  }
  console.log(`  ${graded.scores.pass ? "PASS" : "FAIL"} ${testCase.id} #${rep} · ${graded.explanation}`);
}

async function main() {
  console.log(`change-draft eval · backend ${backendName} · ${jobs.length} runs to do (${done.size} already graded) · context limit ${contextLimit.toLocaleString("en-US")} chars`);
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
  }));
  const rows = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt_id: string; grade: { pass: number }; cost_usd: number; tags: string[] });
  const passed = rows.filter((row) => row.grade.pass).length;
  const cost = rows.reduce((sum, row) => sum + row.cost_usd, 0);
  console.log(`\n${passed}/${rows.length} runs passed · API-equivalent cost ${cost.toFixed(2)} · results in ${out}`);
  if (backendName === "replay" && !fromTraces) {
    if (replayProblems.length) { console.log(`\nReplay does not match the recording:\n${replayProblems.map((problem) => `  ${problem}`).join("\n")}`); process.exitCode = 1; }
    else console.log("Replay matches the recording: every run graded as recorded, with no model call.");
  }
}

void main();
