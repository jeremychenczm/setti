/**
 * Recorded model answers, so an eval can be replayed without calling the model.
 *
 * Each model call is identified by a fingerprint of everything that decides its
 * answer: the system prompt, model, effort, output schema and the request itself.
 * A replay serves the recorded answer only when the new request has the same
 * fingerprint; a different request means the recording no longer describes the
 * code, and the run is reported as stale instead of graded.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Flow = "change-draft" | "money-answer" | "inbox-summary";

export interface RecordedAttempt {
  fingerprint: string;
  output: unknown;
  /** What the server's check found wrong with this answer, as sent back with the next call. Not part of the fingerprint. */
  feedback?: string[];
}
export interface RecordedRun {
  rep: number;
  pass: number;
  attempts: RecordedAttempt[];
  /** How the grader scored the run, as written to results.jsonl. */
  explanation?: string;
}
export interface Recording { flow: Flow; case: string; source: string; runs: RecordedRun[] }

export class StaleRecordingError extends Error {}

/** A short, stable hash of a model call's inputs. Key order is fixed by the code that builds them. */
export function fingerprint(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
}

const file = (flow: Flow, caseId: string) => join(process.cwd(), "evals", "recorded", flow, `${caseId}.json`);

export function loadRecording(flow: Flow, caseId: string): Recording | null {
  const path = file(flow, caseId);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Recording : null;
}

/** Writes one run into its case's recording, replacing an earlier recording of the same rep. */
export function saveRun(flow: Flow, caseId: string, source: string, run: RecordedRun): void {
  const path = file(flow, caseId);
  mkdirSync(join(path, ".."), { recursive: true });
  const recording = loadRecording(flow, caseId) ?? { flow, case: caseId, source, runs: [] };
  recording.source = source;
  recording.runs = [...recording.runs.filter((entry) => entry.rep !== run.rep), run].sort((a, b) => a.rep - b.rep);
  writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`);
}

/**
 * A run's model calls as recorded attempts. A call that was a rewrite carries the
 * problems it was sent back with; they belong to the answer before it. `finalProblems`
 * are the server's findings on the last answer when it was not accepted either.
 */
export function recordedAttempts(calls: { fingerprint?: string; output: unknown; problems?: string[] | null }[], finalProblems: string[] = []): RecordedAttempt[] {
  return calls.map((call, index) => {
    const next = calls[index + 1]?.problems;
    const feedback = next?.length ? next : index === calls.length - 1 && finalProblems.length ? finalProblems : null;
    return { fingerprint: call.fingerprint!, output: call.output, ...(feedback ? { feedback } : {}) };
  });
}

/**
 * Serves one run's recorded answers in call order. With `learn`, it accepts any
 * request and keeps its fingerprint: used once, to turn saved traces into a recording.
 */
export function replayer(run: RecordedRun | undefined, options: { learn?: boolean } = {}) {
  let call = 0;
  const state = {
    /** The fingerprints of the requests made, in order. */
    seen: [] as string[],
    /** Why the recording could not answer, once it could not. */
    stale: null as string | null,
    /** Recorded answers this replay did not need, such as a rewrite the server no longer asks for. */
    unused: () => Math.max(0, (run?.attempts.length ?? 0) - call),
    answer(requestFingerprint: string): unknown {
      const attempt = run?.attempts[call];
      call += 1;
      state.seen.push(requestFingerprint);
      if (!attempt) state.stale = `no recorded answer for model call ${call}`;
      else if (!options.learn && attempt.fingerprint !== requestFingerprint) state.stale = `model call ${call} differs from the recorded request`;
      if (state.stale) throw new StaleRecordingError(state.stale);
      return attempt!.output;
    },
  };
  return state;
}
export type Replayer = ReturnType<typeof replayer>;

/** The model answers saved in a results trace, in call order (the last entry is what Setti saved). */
export function answersFromTrace(path: string): unknown[] {
  const trace = JSON.parse(readFileSync(path, "utf8")) as { role: string; content: string }[];
  return trace.filter((entry) => entry.role === "assistant").slice(0, -1).map((entry) => {
    try { return JSON.parse(entry.content) as unknown; } catch { throw new Error(`${path} holds a failed model call; record it again with the api backend.`); }
  });
}
