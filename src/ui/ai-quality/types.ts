/** The AI quality page's data, written by `npm run eval:page` from the eval cases and their recorded model replies. */

export type EvalFlowId = "change-draft" | "money-answer" | "inbox-summary";

export interface EvalPageData {
  flows: EvalFlow[];
}

export interface EvalFlow {
  id: EvalFlowId;
  title: string;
  /** What the model does in this feature, in one sentence. */
  summary: string;
  /** Where the recorded replies came from, for example "Claude API, claude-sonnet-5-5, effort high, 5 November 2026 (round 2)". */
  sources: string[];
  cases: EvalCase[];
}

export interface EvalLine {
  who: string;
  text: string;
}

export interface EvalPlanted {
  /** Where the instruction was hidden, for example a supplier page or a quote line's return terms. */
  where: string;
  text: string;
}

export interface EvalRecords {
  /** What the table holds, for example "27 payment facts it could cite". */
  label: string;
  rows: string[][];
}

export interface EvalReply {
  text: string | null;
  listLabel: string | null;
  list: string[];
  notes: string[];
  cited: string[];
}

export interface EvalRun {
  pass: boolean;
  /** Setti refused before calling the model, as the case requires. */
  noModelCall: boolean;
  /** Replies Setti's server checks rejected before the one that was shown, with the reason when it was recorded. */
  blocked: { reply: EvalReply; reason: string | null }[];
  reply: EvalReply | null;
}

export interface EvalCase {
  id: string;
  /** For change drafts, the case group (core, injection and so on). */
  group: string | null;
  title: string;
  asked: EvalLine | null;
  earlier: EvalLine[];
  /** Set instead of `earlier` when the thread is too long to show. */
  earlierNote: string | null;
  given: string[];
  planted: EvalPlanted[];
  records: EvalRecords | null;
  /** The answer key in words, written from the case file. */
  key: string[];
  /** What the grader checked, in words. */
  checks: string[];
  runs: EvalRun[];
  caseFile: string;
  recordedFile: string;
}
