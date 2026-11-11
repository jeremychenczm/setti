/**
 * Client inbox summary eval. Each scenario's records go through the inbox's own
 * fact builder (inboxFacts) and Setti's own write-and-check loop
 * (writeCheckedSummary); the shown summary is graded against where each item
 * truly stands, worked out from the scenario alone.
 *
 *   npx tsx evals/inbox-summary/run.ts [--backend claude-code|api] [--label before] [--reps 3] [--concurrency 4] [--fresh]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { SUMMARY_SYSTEM_PROMPT, callSummaryModel, summaryOutputSchema, writeCheckedSummary, type SummaryModel, type SummaryRequest } from "@/ai/inbox-summary";
import { DEFAULT_MODEL } from "@/ai/model";
import { inboxFacts, itemsNow, type InboxView } from "@/payments/inbox-view";
import type { SummarySentence } from "@/payments/schema";
import { runHeadless } from "../lib/claude-code";
import { answersFromTrace, fingerprint, loadRecording, recordedAttempts, replayer, saveRun, type Replayer } from "../lib/replay";
import { stateErrors } from "./grade";
import { SCENARIOS, truthOf, type Scenario } from "./scenarios";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(arg.slice(2), next); i++; } else args.set(arg.slice(2), "true");
}
const backendName = args.get("backend") ?? "claude-code";
if (!["claude-code", "api", "replay"].includes(backendName)) throw new Error(`Unknown backend ${backendName}`);
/** --record saves each graded run's model answers to evals/recorded/; --from-traces <dir> replays a results folder's traces once to record them. */
const recordRuns = args.has("record");
const fromTraces = args.get("from-traces");
const source = args.get("source") ?? `Claude API, ${process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL}, effort high, ${new Date().toISOString().slice(0, 10)}`;
const replayProblems: string[] = [];
const SUMMARY_SCHEMA = betaZodOutputFormat(summaryOutputSchema).schema;
/** Everything that decides the model's answer to one summary call. */
const summaryFingerprint = (request: SummaryRequest) => fingerprint("summary", process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL, "high", SUMMARY_SYSTEM_PROMPT, SUMMARY_SCHEMA, request);
if (backendName === "api" && existsSync(".env.local")) process.loadEnvFile(".env.local");
const label = args.get("label");
const reps = Number(args.get("reps") ?? 3);
const concurrency = Number(args.get("concurrency") ?? 4);
if (!existsSync(join(process.cwd(), "evals", "inbox-summary"))) throw new Error("Run this from the setti-app directory.");
const flow = join(process.cwd(), "evals", "results", `inbox-summary-${backendName}${label ? `-${label}` : ""}`);
const out = join(flow, "baseline");
if (args.has("fresh")) rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "traces"), { recursive: true });
writeFileSync(join(flow, "_state.json"), JSON.stringify({
  metrics: [
    { id: "pass", label: "Pass", kind: "binary" },
    { id: "raw_state_error", label: "Raw state err", kind: "binary", better: "lower" },
    { id: "first_try", label: "First try", kind: "binary" },
    { id: "shown", label: "Shown", kind: "binary" },
  ],
  perf_fields: [{ id: "cost_usd", label: "API-equiv $" }, { id: "in_tokens", label: "In tokens" }, { id: "out_tokens", label: "Out tokens" }, { id: "latency_s", label: "Latency", unit: "s" }],
}, null, 2));

interface Attempt { sentences: SummarySentence[] | null; kind: string; message?: string; costUsd: number; durationMs: number; inTokens: number; outTokens: number; fingerprint?: string; problems?: string[] | null }

function model(recordAttempt: (attempt: Attempt) => void, replay?: Replayer): SummaryModel {
  let current = "";
  let sentBack: string[] | null = null;     // the problems this call was sent back with, if it is a rewrite
  const record = (attempt: Attempt) => recordAttempt({ ...attempt, fingerprint: current, problems: sentBack });
  const fingerprinted = (call: SummaryModel): SummaryModel => async (request) => {
    current = summaryFingerprint(request);
    sentBack = request.previousAttemptProblems ?? null;
    return call(request);
  };
  if (backendName === "replay") return fingerprinted(async () => {
    const sentences = summaryOutputSchema.shape.sentences.parse(replay!.answer(current));
    record({ sentences, kind: "ok", costUsd: 0, durationMs: 0, inTokens: 0, outTokens: 0 });
    return { sentences, model: "replay" };
  });
  if (backendName === "api") return fingerprinted(async (request) => {
    const started = Date.now();
    const result = await callSummaryModel(request);
    const usage = result.usage;
    // Sonnet 5.5 list prices per million tokens: input $2, output $10, cache read $0.20, five-minute cache write $2.50.
    const costUsd = usage ? (usage.inputTokens * 2 + usage.outputTokens * 10 + usage.cacheReadTokens * 0.2 + usage.cacheWriteTokens * 2.5) / 1e6 : 0;
    record({ sentences: result.sentences, kind: "ok", costUsd, durationMs: Date.now() - started, inTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0, outTokens: usage?.outputTokens ?? 0 });
    return result;
  });
  return fingerprinted(async (request: SummaryRequest) => {
    const result = await runHeadless({ model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL, effort: "high", system: SUMMARY_SYSTEM_PROMPT, user: JSON.stringify(request), schema: betaZodOutputFormat(summaryOutputSchema).schema, timeoutMs: 300_000 });
    const usage = result.usage;
    const base = { costUsd: result.costUsd, durationMs: result.durationMs, inTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0, outTokens: usage?.outputTokens ?? 0 };
    if (result.kind !== "ok") { record({ sentences: null, kind: result.kind, message: result.message, ...base }); throw new Error(`${result.kind}: ${result.message}`); }
    const parsed = summaryOutputSchema.safeParse(result.json);
    record({ sentences: parsed.success ? parsed.data.sentences : null, kind: parsed.success ? "ok" : "error", message: parsed.success ? undefined : parsed.error.message, ...base });
    if (!parsed.success) throw new Error("The model did not return a complete summary.");
    return { sentences: parsed.data.sentences, model: result.model };
  });
}

/** The scenario's records as the ledger rows the inbox reads, so its own item-by-item code runs on them. */
function ledgerOf(timeline: ReturnType<Scenario["timeline"]>) {
  return {
    authorizations: timeline.holds.map((hold) => ({ id: hold.id, itemId: hold.itemId, amountCents: hold.amountCents, status: hold.status, expiresAt: null })),
    captures: timeline.captures.map((capture) => ({ id: capture.id, authorizationId: capture.holdId, itemId: capture.itemId, amountCents: capture.amountCents, status: "completed" })),
    refunds: timeline.refunds.map((refund) => ({ id: refund.id, captureId: refund.captureId, amountCents: refund.amountCents, status: "completed" })),
  } as unknown as Parameters<typeof itemsNow>[0];
}

function view(scenario: Scenario): { view: InboxView; truth: ReturnType<typeof truthOf> } {
  const timeline = scenario.timeline();
  const truth = truthOf(timeline);
  const items = itemsNow(ledgerOf(timeline), (itemId) => itemId ? timeline.labels[itemId] ?? "An item" : "Design services");
  const sum = (field: "heldCents" | "chargedCents" | "refundedCents") => items.reduce((total, item) => total + item[field], 0);
  return {
    truth,
    view: {
      role: "client", reader: "Emma", simulatedDays: 0, lastCheck: null, reminders: [], project: { key: "maple", name: "Maple Ave" },
      events: timeline.events, totals: { heldCents: sum("heldCents"), chargedCents: sum("chargedCents"), refundedCents: sum("refundedCents") }, items,
      readAt: "2026-11-05T16:00:00Z", unread: [], opened: true,
    },
  };
}

const resultsPath = join(out, "results.jsonl");
const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => { const row = JSON.parse(line) as { prompt_id: string; rep: number }; return `${row.prompt_id}#${row.rep}`; }) : []);

async function runJob(scenario: Scenario, rep: number) {
  const { view: inbox, truth } = view(scenario);
  const request = { audience: "client" as const, reader: "Emma (the client)", facts: inboxFacts(inbox) };
  const attempts: Attempt[] = [];
  const recorded = loadRecording("inbox-summary", scenario.id)?.runs.find((run) => run.rep === rep);
  let replay: Replayer | undefined;
  if (backendName === "replay") {
    replay = fromTraces
      ? replayer({ rep, pass: 0, attempts: answersFromTrace(join(fromTraces, "traces", `${scenario.id}_rep${rep}.json`)).map((output) => ({ fingerprint: "", output })) }, { learn: true })
      : replayer(recorded);
  }
  let written: Awaited<ReturnType<typeof writeCheckedSummary>> | null = null;
  let failure: string | null = null;
  try { written = await writeCheckedSummary(request, model((attempt) => attempts.push(attempt), replay)); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  writeFileSync(join(out, "traces", `${scenario.id}_rep${rep}.json`), JSON.stringify([
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(request, null, 2) },
    ...attempts.map((attempt) => ({ role: "assistant", content: attempt.sentences ? JSON.stringify(attempt.sentences, null, 2) : `[${attempt.kind}] ${attempt.message ?? ""}` })),
    { role: "assistant", content: `Shown: ${written?.written ? written.written.sentences.map((sentence) => sentence.text).join(" ") : "no summary"}${written && !written.written ? `\nProblems: ${written.problems.join(" | ")}` : ""}` },
  ], null, 2));
  if (replay?.stale) {
    replayProblems.push(`${scenario.id} #${rep}: stale recording (${replay.stale})`);
    console.log(`  STALE ${scenario.id} #${rep} · ${replay.stale}`);
    return;
  }
  if (failure) {
    appendFileSync(join(out, "errors.jsonl"), `${JSON.stringify({ prompt_id: scenario.id, rep, failure_class: "error", message: failure.slice(0, 300) })}\n`);
    console.log(`  ! ${scenario.id} #${rep}: ${failure.slice(0, 120)}`);
    return;
  }
  const shown = written!.written?.sentences ?? null;
  const firstErrors = attempts[0]?.sentences ? stateErrors(attempts[0].sentences, truth) : [];
  const shownErrors = shown ? stateErrors(shown, truth) : [];
  const pass = !!shown && shownErrors.length === 0;
  const row = {
    prompt_id: scenario.id, rep, prompt: scenario.title, tags: scenario.tags, status: "ok", stop_reason: shown ? "shown" : "withheld",
    grade: { pass: pass ? 1 : 0, raw_state_error: firstErrors.length ? 1 : 0, first_try: attempts.length === 1 && !!shown ? 1 : 0, shown: shown ? 1 : 0 },
    explanation: { pass: [shown ? `shown: ${shown.map((sentence) => sentence.text).join(" ")}` : `withheld: ${written!.problems.join(" | ")}`, ...shownErrors, ...(firstErrors.length ? [`first attempt: ${firstErrors.join(" ")}`] : [])].join(" · ") },
    model: DEFAULT_MODEL, cost_usd: Number(attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0).toFixed(4)),
    in_tokens: attempts.reduce((sum, attempt) => sum + attempt.inTokens, 0), out_tokens: attempts.reduce((sum, attempt) => sum + attempt.outTokens, 0),
    latency_s: Number((attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / 1000).toFixed(1)),
    meta: { attempts: attempts.length, facts: request.facts.length, true_held_cents: truth.heldCents },
  };
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  if (backendName === "replay" && !fromTraces && recorded && recorded.pass !== row.grade.pass) replayProblems.push(`${scenario.id} #${rep}: recorded ${recorded.pass ? "PASS" : "FAIL"}, replayed ${row.grade.pass ? "PASS" : "FAIL"}`);
  if (recordRuns && (backendName === "api" || fromTraces)) {
    saveRun("inbox-summary", scenario.id, source, {
      rep, pass: row.grade.pass, explanation: row.explanation.pass,
      attempts: recordedAttempts(attempts.map((attempt) => ({ fingerprint: attempt.fingerprint, output: attempt.sentences, problems: attempt.problems })), written!.written ? [] : written!.problems),
    });
  }
  console.log(`  ${pass ? "PASS" : "FAIL"} ${scenario.id} #${rep} · ${row.explanation.pass.slice(0, 400)}`);
}

async function main() {
  const only = args.get("cases")?.split(",").map((id) => id.trim()).filter(Boolean);
  const repsOf = (scenario: Scenario) => backendName === "replay" && !fromTraces
    ? (loadRecording("inbox-summary", scenario.id)?.runs.map((run) => run.rep) ?? [0])
    : Array.from({ length: reps }, (_, rep) => rep);
  const jobs = SCENARIOS.filter((scenario) => !only || only.includes(scenario.id)).flatMap((scenario) => repsOf(scenario).map((rep) => ({ scenario, rep }))).filter((job) => !done.has(`${job.scenario.id}#${job.rep}`));
  console.log(`inbox-summary eval · backend ${backendName}${label ? ` · ${label}` : ""} · ${jobs.length} runs`);
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await runJob(job.scenario, job.rep); }));
  const rows = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { grade: { pass: number; raw_state_error: number }; cost_usd: number });
  console.log(`\n${rows.filter((row) => row.grade.pass).length}/${rows.length} passed · first attempts with a state error: ${rows.filter((row) => row.grade.raw_state_error).length} · API-equivalent ${rows.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(2)}`);
  if (backendName === "replay" && !fromTraces) {
    if (replayProblems.length) { console.log(`\nReplay does not match the recording:\n${replayProblems.map((problem) => `  ${problem}`).join("\n")}`); process.exitCode = 1; }
    else console.log("Replay matches the recording: every run graded as recorded, with no model call.");
  }
}

void main();
