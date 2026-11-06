/**
 * Money-answer eval runner. Each question goes through Setti's real entry point,
 * runCaseAi, with the case's recorded money evidence, so the server's checks of
 * every amount and status and its one rewrite run as in production.
 *
 *   npx tsx evals/money-answer/run.ts [--backend claude-code|api|null] [--cases id,id] [--reps 1] [--stability-reps 3] [--concurrency 3] [--fresh]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGE_SYSTEM_PROMPT } from "@/ai/model";
import type { MoneyAnswer } from "@/ai/money-types";
import { runCaseAi } from "@/chat/service";
import type { ChatStore, StoredCase } from "@/chat/types";
import { backend, type BackendName } from "../change-draft/backends";
import type { DraftCase } from "../change-draft/cases";
import type { Attempt } from "../change-draft/grade";
import { CASES, type MoneyCase } from "./cases";
import { assertsClaim } from "./grade";
import { answersFromTrace, loadRecording, replayer, saveRun, type Replayer } from "../lib/replay";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(arg.slice(2), next); i++; } else args.set(arg.slice(2), "true");
}
const backendName = (args.get("backend") ?? "claude-code") as BackendName;
if (!["claude-code", "api", "null", "replay"].includes(backendName)) throw new Error(`Unknown backend ${backendName}`);
/** --record saves each graded run's model answers to evals/recorded/; --from-traces <dir> replays a results folder's traces once to record them. */
const recordRuns = args.has("record");
const fromTraces = args.get("from-traces");
const source = args.get("source") ?? `Claude API, ${process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5"}, effort high, ${new Date().toISOString().slice(0, 10)}`;
const replayProblems: string[] = [];
if (backendName === "api" && existsSync(".env.local")) process.loadEnvFile(".env.local");
const reps = Number(args.get("reps") ?? 1);
const stabilityReps = Number(args.get("stability-reps") ?? 3);
const concurrency = Number(args.get("concurrency") ?? 3);
const only = args.get("cases")?.split(",").map((id) => id.trim()).filter(Boolean);
if (!existsSync(join(process.cwd(), "evals", "money-answer"))) throw new Error("Run this from the setti-app directory.");
const flow = join(process.cwd(), "evals", "results", `money-answer-${backendName}`);
const out = join(flow, "baseline");
if (args.has("fresh")) rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "traces"), { recursive: true });
writeFileSync(join(flow, "_state.json"), JSON.stringify({
  metrics: [{ id: "pass", label: "Pass", kind: "binary" }, { id: "answered", label: "Answered", kind: "binary" }, { id: "first_try", label: "First try", kind: "binary" }],
  perf_fields: [{ id: "cost_usd", label: "API-equiv $" }, { id: "in_tokens", label: "In tokens" }, { id: "out_tokens", label: "Out tokens" }, { id: "latency_s", label: "Latency", unit: "s" }],
}, null, 2));

const resultsPath = join(out, "results.jsonl");
const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => { const row = JSON.parse(line) as { prompt_id: string; rep: number }; return `${row.prompt_id}#${row.rep}`; }) : []);
const unknown = only?.filter((id) => !CASES.some((entry) => entry.id === id)) ?? [];
if (unknown.length) throw new Error(`Unknown case ids: ${unknown.join(", ")}`);

interface Saved { text?: string; moneyAnswer?: MoneyAnswer; model?: string; failed?: string }


function grade(testCase: MoneyCase, saved: Saved, attempts: Attempt[]) {
  const answer = saved.moneyAnswer?.answer;
  const answered = !!answer && saved.model !== "system";
  const written = answer ? [answer.summary.text, ...answer.rows.map((row) => `${row.label}: ${row.status}${row.amount ? ` ${row.amount}` : ""}`), ...answer.notes.map((note) => note.text)].join("\n") : "";
  const cited = new Set(saved.moneyAnswer?.facts.map((fact) => fact.id) ?? []);
  const problems: string[] = [];
  const expected = testCase.expected;
  for (const claim of expected.requiredClaims ?? []) if (!new RegExp(claim, "iu").test(written)) problems.push(`did not state /${claim}/`);
  for (const claim of expected.forbiddenClaims ?? []) {
    // "No refund has been completed" denies the claim; only a match that asserts it counts.
    const made = [...written.matchAll(new RegExp(claim, "giu"))].find((match) => assertsClaim(written, match));
    if (made) problems.push(`wrote "${made[0]}"`);
  }
  for (const id of expected.mustCite ?? []) if (!cited.has(id)) problems.push(`did not cite ${id}`);
  if (expected.showEvidence !== undefined && saved.moneyAnswer?.showEvidence !== expected.showEvidence) problems.push(`showEvidence ${saved.moneyAnswer?.showEvidence ?? "unset"}, expected ${expected.showEvidence}`);
  if (expected.minRows && (answer?.rows.length ?? 0) < expected.minRows) problems.push(`${answer?.rows.length ?? 0} rows, expected at least ${expected.minRows}`);
  if (!answered) problems.unshift(saved.failed ? `error: ${saved.failed.slice(0, 160)}` : saved.moneyAnswer ? "the written answer failed verification twice; only the records were shown" : `no money answer: ${saved.text?.slice(0, 160)}`);
  const pass = answered && problems.length === 0;
  return { scores: { pass: pass ? 1 : 0, answered: answered ? 1 : 0, first_try: attempts.length === 1 && answered ? 1 : 0 }, explanation: [answered ? `answer: ${written.replace(/\n/gu, " | ")}` : "", ...problems].filter(Boolean).join(" · ") };
}

async function runJob(testCase: MoneyCase, rep: number) {
  const { quote, moneyContext } = testCase.fixture();
  const messages = testCase.messages();
  const trigger = messages.at(-1)!;
  const saved: Saved = {};
  const attempts: Attempt[] = [];
  const state: StoredCase = { id: `eval-${testCase.id}`, projectKey: "maple", messages, draft: null, activeMessageId: null, quote };
  const unsupported = () => { throw new Error("Not used by the eval."); };
  const store: ChatStore = {
    getCase: async () => state, appendMessage: unsupported, sendQuote: unsupported, getQuote: unsupported,
    beginAi: async () => ({ status: "started", runId: "eval-run", state }), reportAiStage: async () => {},
    readMoneyContext: async () => structuredClone(moneyContext),
    completeAi: async (_s, _k, _m, _r, result) => { Object.assign(saved, { text: result.text, moneyAnswer: result.moneyAnswer, model: result.model }); return state; },
    failAi: async (_s, _k, _m, _r, error) => { saved.failed = error; return state; },
  };
  const placeholder = { expected: { outcome: "no_draft" } } as unknown as DraftCase;
  const recorded = loadRecording("money-answer", testCase.id)?.runs.find((run) => run.rep === rep);
  let replay: Replayer | undefined;
  if (backendName === "replay") {
    replay = fromTraces
      ? replayer({ rep, pass: 0, attempts: answersFromTrace(join(fromTraces, "traces", `${testCase.id}_rep${rep}.json`)).map((output) => ({ fingerprint: "", output })) }, { learn: true })
      : replayer(recorded);
  }
  try {
    await runCaseAi(store, "eval-session", "maple", trigger.id, {
      configured: () => true, readPage: async () => { throw new Error("No pages in money cases."); },
      callModel: backend(backendName, placeholder, (attempt) => attempts.push(attempt), { timeoutMs: 600_000, contextLimit: 400_000, replay }),
    });
  } catch { /* the saved outcome records what Setti showed or reported */ }
  writeFileSync(join(out, "traces", `${testCase.id}_rep${rep}.json`), JSON.stringify([
    { role: "system", content: CHANGE_SYSTEM_PROMPT },
    { role: "user", content: `[Maple money evidence: ${moneyContext.facts.length} facts; question: ${trigger.text}]` },
    ...attempts.flatMap((attempt) => [
      ...(attempt.problems ? [{ role: "user", content: `previousAttemptProblems:\n${attempt.problems.join("\n")}` }] : []),
      { role: "assistant", content: attempt.output ? JSON.stringify(attempt.output, null, 2) : `[${attempt.kind}] ${attempt.message ?? ""}` },
    ]),
    { role: "assistant", content: `Shown by Setti: ${JSON.stringify(saved, null, 2)}` },
  ], null, 2));
  if (replay?.stale) {
    replayProblems.push(`${testCase.id} #${rep}: stale recording (${replay.stale})`);
    console.log(`  STALE ${testCase.id} #${rep} · ${replay.stale}`);
    return;
  }
  const infra = attempts.find((attempt) => attempt.kind === "error" || attempt.kind === "timeout");
  const costUsd = attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
  if (infra) {
    appendFileSync(join(out, "errors.jsonl"), `${JSON.stringify({ prompt_id: testCase.id, rep, failure_class: infra.kind, message: infra.message, cost_usd: costUsd })}\n`);
    console.log(`  ! ${testCase.id} #${rep}: ${infra.kind} ${infra.message?.slice(0, 120) ?? ""}`);
    return;
  }
  const graded = grade(testCase, saved, attempts);
  const inTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage ? attempt.usage.inputTokens + attempt.usage.cacheReadTokens + attempt.usage.cacheWriteTokens : 0), 0);
  const row = {
    prompt_id: testCase.id, rep, prompt: `${testCase.title}\n\n${trigger.text}`, tags: testCase.tags, status: "ok", stop_reason: graded.scores.answered ? "answered" : "not_answered",
    grade: graded.scores, explanation: { pass: graded.explanation }, model: attempts.find((attempt) => attempt.model)?.model ?? backendName,
    cost_usd: Number(costUsd.toFixed(4)), in_tokens: inTokens, out_tokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.outputTokens ?? 0), 0),
    latency_s: Number((attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / 1000).toFixed(1)), meta: { backend: backendName, attempts: attempts.length },
  };
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  if (backendName === "replay" && !fromTraces && recorded && recorded.pass !== graded.scores.pass) replayProblems.push(`${testCase.id} #${rep}: recorded ${recorded.pass ? "PASS" : "FAIL"}, replayed ${graded.scores.pass ? "PASS" : "FAIL"}`);
  if (recordRuns && (backendName === "api" || fromTraces)) {
    saveRun("money-answer", testCase.id, source, { rep, pass: graded.scores.pass, attempts: attempts.map((attempt) => ({ fingerprint: attempt.fingerprint!, output: attempt.output })) });
  }
  console.log(`  ${graded.scores.pass ? "PASS" : "FAIL"} ${testCase.id} #${rep} · ${graded.explanation.slice(0, 420)}`);
}

/** Grades the recorded answers again, after a grader fix, without asking the model. */
function regrade() {
  const rows = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt_id: string; rep: number; meta: { attempts: number }; grade: unknown; explanation: unknown });
  for (const row of rows) {
    const testCase = CASES.find((entry) => entry.id === row.prompt_id)!;
    const trace = JSON.parse(readFileSync(join(out, "traces", `${row.prompt_id}_rep${row.rep}.json`), "utf8")) as { content: string }[];
    const saved = JSON.parse(trace.at(-1)!.content.replace(/^Shown by Setti: /u, "")) as Saved;
    const graded = grade(testCase, saved, Array.from({ length: row.meta.attempts }) as Attempt[]);
    row.grade = graded.scores;
    row.explanation = { pass: graded.explanation };
    console.log(`  ${graded.scores.pass ? "PASS" : "FAIL"} ${row.prompt_id} #${row.rep} · ${graded.explanation.slice(0, 300)}`);
  }
  writeFileSync(resultsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function main() {
  if (args.has("regrade")) return regrade();
  const selected = CASES.filter((entry) => !only || only.includes(entry.id));
  const repsOf = (testCase: MoneyCase) => backendName === "replay" && !fromTraces
    ? (loadRecording("money-answer", testCase.id)?.runs.map((run) => run.rep) ?? [0])
    : Array.from({ length: testCase.stability ? Math.max(reps, stabilityReps) : reps }, (_, rep) => rep);
  const jobs = selected.flatMap((testCase) => repsOf(testCase).map((rep) => ({ testCase, rep }))).filter((job) => !done.has(`${job.testCase.id}#${job.rep}`));
  console.log(`money-answer eval · backend ${backendName} · ${jobs.length} runs`);
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await runJob(job.testCase, job.rep); }));
  const rows = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { grade: { pass: number }; cost_usd: number }) : [];
  console.log(`\n${rows.filter((row) => row.grade.pass).length}/${rows.length} passed · API-equivalent ${rows.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(2)}`);
  if (backendName === "replay" && !fromTraces) {
    if (replayProblems.length) { console.log(`\nReplay does not match the recording:\n${replayProblems.map((problem) => `  ${problem}`).join("\n")}`); process.exitCode = 1; }
    else console.log("Replay matches the recording: every run graded as recorded, with no model call.");
  }
}

void main();
