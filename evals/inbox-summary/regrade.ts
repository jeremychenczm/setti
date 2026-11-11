/**
 * Grades recorded inbox summaries again after a grader fix, without asking the
 * model: `npx tsx evals/inbox-summary/regrade.ts <results folder>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SummarySentence } from "@/payments/schema";
import { amountErrors } from "./grade";
import { SCENARIOS, truthOf } from "./scenarios";

const flow = process.argv[2];
if (!flow) throw new Error("Pass the results folder, for example evals/results/inbox-summary-claude-code-before");
const out = join(flow, "baseline");
const rows = readFileSync(join(out, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const regraded = rows.map((row) => {
  const scenario = SCENARIOS.find((entry) => entry.id === row.prompt_id)!;
  const truth = truthOf(scenario.timeline());
  const trace = JSON.parse(readFileSync(join(out, "traces", `${row.prompt_id}_rep${row.rep}.json`), "utf8")) as { role: string; content: string }[];
  const attempts = trace.slice(2, -1).map((turn) => turn.content.startsWith("[{") || turn.content.startsWith("[\n") ? JSON.parse(turn.content) as SummarySentence[] : null);
  const shownText = trace.at(-1)!.content;
  const shown = shownText.startsWith("Shown: no summary") ? null : attempts.at(-1) ?? null;
  const firstErrors = attempts[0] ? amountErrors(attempts[0], truth) : [];
  const shownErrors = shown ? amountErrors(shown, truth) : [];
  const pass = !!shown && shownErrors.length === 0;
  return {
    ...row,
    grade: { pass: pass ? 1 : 0, raw_amount_error: firstErrors.length ? 1 : 0, first_try: attempts.length === 1 && !!shown ? 1 : 0, shown: shown ? 1 : 0 },
    explanation: { pass: [shown ? `shown: ${shown.map((sentence) => sentence.text).join(" ")}` : "withheld", ...shownErrors, ...(firstErrors.length ? [`first attempt: ${firstErrors.join(" ")}`] : [])].join(" · ") },
  };
});
writeFileSync(join(out, "results.jsonl"), `${regraded.map((row) => JSON.stringify(row)).join("\n")}\n`);
for (const row of regraded) console.log(`${row.grade.pass ? "PASS" : "FAIL"} ${row.prompt_id} #${row.rep} · ${String(row.explanation.pass).slice(0, 360)}`);
console.log(`\n${regraded.filter((row) => row.grade.pass).length}/${regraded.length} passed · first attempts with a wrong amount: ${regraded.filter((row) => row.grade.raw_amount_error).length}`);
