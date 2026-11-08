import { Check, X } from "lucide-react";
import Link from "next/link";
import styles from "./AiQuality.module.css";
import { OpenFromHash } from "./OpenFromHash";
import { RunTabs } from "./RunTabs";
import type { EvalCase, EvalFlow, EvalPageData, EvalReply, EvalRun } from "./types";

const REPO = "https://github.com/jeremychenczm/setti";
const GROUPS: Record<string, string> = {
  core: "Everyday requests", language: "Tricky wording", "existing-draft": "Changing a draft",
  large: "Large projects", injection: "Planted instructions", hard: "Hard cases",
};
const quoted = (text: string) => `“${text}”`;

function resultOf(entry: EvalCase): { text: string; tone: "pass" | "step" | "fail" } {
  const runs = entry.runs;
  const passed = runs.filter((run) => run.pass).length;
  const rewrites = runs.filter((run) => run.pass && run.blocked.length > 0).length;
  if (runs.length === 1 && runs[0].noModelCall && runs[0].pass) return { text: "Refused, as expected", tone: "pass" };
  const text = `${passed}/${runs.length} passed${rewrites ? ` · ${rewrites} rewrite${rewrites === 1 ? "" : "s"}` : ""}`;
  return { text, tone: passed < runs.length ? "fail" : rewrites ? "step" : "pass" };
}

function Reply({ reply }: { reply: EvalReply }) {
  return (
    <>
      {reply.text && <p className={styles.say}>{reply.text}</p>}
      {reply.list.length > 0 && (reply.listLabel
        ? <p className={styles.draft}>{reply.listLabel}: <span>{reply.list.join(" ")}</span></p>
        : <ul className={styles.plain}>{reply.list.map((line, index) => <li key={index}>{line}</li>)}</ul>)}
      {reply.notes.map((note, index) => <p key={index} className={styles.note}>{note}</p>)}
      {reply.cited.length > 0 && <p className={styles.cited}>Cited records: <span className={styles.mono}>{reply.cited.join(", ")}</span></p>}
    </>
  );
}

function RunPanel({ entry, run }: { entry: EvalCase; run: EvalRun }) {
  return (
    <dl className={styles.qa}>
      <dt>Reply</dt>
      <dd>
        {run.blocked.map((blocked, index) => (
          <div key={index} className={styles.blocked}>
            <p><b>Blocked by Setti&apos;s server and never shown</b>{blocked.reason ? `: ${blocked.reason}` : ". Setti asked the model for one rewrite."}</p>
            <Reply reply={blocked.reply} />
          </div>
        ))}
        {run.reply ? <Reply reply={run.reply} /> : <p className={styles.say}>{run.noModelCall ? "Setti refused before calling the model." : "No reply was recorded."}</p>}
      </dd>
      <dt>Graded</dt>
      <dd>
        {run.pass ? (
          <ul className={styles.checks}>
            {entry.checks.map((check) => <li key={check}><Check aria-hidden size={15} className={styles.ok} />{check}</li>)}
            {run.blocked.length > 0 && <li className={styles.stepLine}><Check aria-hidden size={15} className={styles.step} />Passed after one rewrite</li>}
          </ul>
        ) : (
          <p className={styles.failed}><X aria-hidden size={15} />Failed. The recorded run has the details.</p>
        )}
      </dd>
    </dl>
  );
}

function CaseItem({ entry }: { entry: EvalCase }) {
  const result = resultOf(entry);
  const labels = entry.runs.map((run, index) => `Run ${index + 1}${run.blocked.length ? " · rewrite" : ""}${run.pass ? "" : " · failed"}`);
  return (
    <li>
      <details id={entry.id} className={styles.case}>
        <summary className={styles.row}>
          <span className={styles.title}>{entry.title}</span>
          <span className={`${styles.result} ${styles[result.tone]}`}>{result.text}</span>
        </summary>
        <div className={styles.detail}>
          <dl className={styles.qa}>
            {entry.asked && (<><dt>Asked</dt><dd><p className={styles.say}><b>{entry.asked.who}:</b> {entry.asked.text}</p></dd></>)}
            {(entry.earlier.length > 0 || entry.earlierNote) && (
              <>
                <dt>Earlier in the chat</dt>
                <dd>
                  {entry.earlierNote
                    ? <p className={styles.muted}>{entry.earlierNote}. <a href={entry.caseFile} target="_blank" rel="noopener noreferrer">See the case file</a></p>
                    : <div className={styles.earlier}>{entry.earlier.map((line, index) => <p key={index}><b>{line.who}:</b> {line.text}</p>)}</div>}
                </dd>
              </>
            )}
            <dt>Given</dt>
            <dd>
              {entry.given.map((line) => <p key={line} className={styles.muted}>{line}</p>)}
              {entry.planted.map((planted) => (
                <p key={planted.where} className={styles.planted}><b>Planted in {planted.where}:</b> {quoted(planted.text)}</p>
              ))}
              {entry.records && (
                <details className={styles.records}>
                  <summary>{entry.records.label}</summary>
                  <div className={styles.tableWrap}>
                    <table><tbody>{entry.records.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>
                  </div>
                </details>
              )}
            </dd>
            <dt>Right answer</dt>
            <dd>{entry.key.map((line) => <p key={line} className={styles.say}>{line}</p>)}</dd>
          </dl>
          {entry.runs.length === 1
            ? <RunPanel entry={entry} run={entry.runs[0]} />
            : <RunTabs labels={labels} panels={entry.runs.map((run, index) => <RunPanel key={index} entry={entry} run={run} />)} />}
          <p className={styles.links}>
            <a href={entry.caseFile} target="_blank" rel="noopener noreferrer">Case file</a>
            <a href={entry.recordedFile} target="_blank" rel="noopener noreferrer">Recorded replies</a>
          </p>
        </div>
      </details>
    </li>
  );
}

function FlowSection({ flow }: { flow: EvalFlow }) {
  const groups = flow.id === "change-draft" ? [...new Set(flow.cases.map((entry) => entry.group ?? ""))] : [null];
  return (
    <section className={styles.flow} aria-labelledby={`flow-${flow.id}`}>
      <h2 id={`flow-${flow.id}`}>{flow.title}</h2>
      <p className={styles.sub}>{flow.summary} {flow.cases.length} cases. Recorded: {flow.sources.join("; ")}.</p>
      {groups.map((group) => (
        <div key={group ?? "all"}>
          {group !== null && <h3 className={styles.group}>{GROUPS[group] ?? group}</h3>}
          <ul className={styles.cases}>
            {flow.cases.filter((entry) => group === null || entry.group === group).map((entry) => <CaseItem key={entry.id} entry={entry} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function AiQuality({ data }: { data: EvalPageData }) {
  const runs = data.flows.flatMap((flow) => flow.cases.flatMap((entry) => entry.runs));
  const cases = data.flows.reduce((sum, flow) => sum + flow.cases.length, 0);
  const rewrites = runs.filter((run) => run.pass && run.blocked.length > 0).length;
  const failed = runs.filter((run) => !run.pass).length;
  return (
    <div className={styles.page}>
      <OpenFromHash />
      <header className={styles.bar}>
        <div className={styles.barInner}>
          <Link href="/" className={styles.brand}><i aria-hidden />Setti</Link>
          <nav className={styles.nav} aria-label="Site">
            <Link href="/try">Try it</Link>
            <span className={styles.current} aria-current="page">AI quality</span>
            <a href={REPO} target="_blank" rel="noopener noreferrer">Source</a>
          </nav>
        </div>
      </header>
      <main className={styles.col}>
        <section className={styles.hero}>
          <h1>AI quality</h1>
          <p className={styles.lead}>Setti uses Claude to draft quote changes, answer payment questions and summarize a client&apos;s inbox. Below is every test case: what was asked, the right answer, what the model replied, and how code graded it.</p>
          <p className={styles.meta}>The answer keys were written before any model answered. Code grades every reply; no model judges another. This page shows the recorded replies and calls no model.</p>
        </section>
        <section className={styles.score} aria-label="Results">
          {data.flows.map((flow) => {
            const flowRuns = flow.cases.flatMap((entry) => entry.runs);
            return (
              <div key={flow.id}>
                <b>{flowRuns.filter((run) => run.pass).length}<small> / {flowRuns.length}</small></b>
                <span>{flow.title.toLowerCase()} passed</span>
              </div>
            );
          })}
        </section>
        <p className={styles.scoreNote}>
          {failed ? `${failed} of ${runs.length} runs failed. ` : ""}
          {rewrites ? `In ${rewrites} of ${runs.length} runs Setti's server blocked the model's first reply and the rewrite passed. Those blocked replies are shown in their cases.` : ""}
        </p>
        {data.flows.map((flow) => <FlowSection key={flow.id} flow={flow} />)}
        <section className={styles.limits} aria-labelledby="limits">
          <h2 id="limits">What these numbers don&apos;t show</h2>
          <ul>
            <li>{cases} cases and {runs.length} runs is a small set. A clean result still allows a real failure rate of a few percent.</li>
            <li>Easy requests were left out on purpose, so this is a hard set, not how often requests succeed in the app.</li>
            <li>The cases were written by the people who built Setti, in English, with fictional data and one model setting.</li>
            <li>How the evals run, and what earlier rounds found and changed: <a href={`${REPO}/blob/main/evals/README.md`} target="_blank" rel="noopener noreferrer">evals/README.md</a></li>
          </ul>
        </section>
      </main>
      <footer className={styles.foot}>
        <div className={styles.col}>
          <span>From the repository:</span>
          <a href={`${REPO}/blob/main/evals/CASES.md`} target="_blank" rel="noopener noreferrer">evals/CASES.md</a>
          <a href={`${REPO}/tree/main/evals/recorded`} target="_blank" rel="noopener noreferrer">evals/recorded/</a>
        </div>
      </footer>
    </div>
  );
}
