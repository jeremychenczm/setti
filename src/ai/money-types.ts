import type { CaseKey } from "../chat/types";
import type { NonRefundableFee } from "../pricing/types";

/** Server-owned evidence, never a model-supplied URL or monetary value. */
export interface MoneySource {
  id: string;
  kind: "quote" | "approval" | "payment" | "supplier";
  label: string;
  href: string;
  recordedAt: string | null;
}

export interface MoneyFact {
  id: string;
  /** A complete statement derived from the recorded facts. Older stored answers may also carry a legacy translation, which is not shown. */
  text: { en: string };
  sourceIds: string[];
}

/** A consistent, read-only snapshot scoped to the owning browser and case. */
export interface MoneyContext {
  projectKey: CaseKey;
  quoteId: string;
  version: number;
  checkedAt: string;
  /** Latest stored provider observation; null means no provider evidence was found. */
  providerRecordedAt: string | null;
  mode: "recorded_sandbox";
  facts: MoneyFact[];
  sources: MoneySource[];
  /** Uncertainty and missing-record warnings cannot be hidden by model selection. */
  mandatoryFactIds?: string[];
  /** Each item's recorded money, keyed for the model; the answer's item table is built from these. */
  items?: MoneyItem[];
}

/** One item's recorded state, in fixed words: the server derives it from the records, never the model. */
export type MoneyStatus = "charged" | "on_hold" | "released" | "refunded" | "refund_due" | "waiting_for_supplier_credit" | "waiting_for_result" | "not_charged";

export const MONEY_STATUS_LABEL: Record<MoneyStatus, string> = {
  charged: "Charged", on_hold: "On hold", released: "Released", refunded: "Refunded", refund_due: "Refund due",
  waiting_for_supplier_credit: "Waiting for supplier credit", waiting_for_result: "Waiting for result", not_charged: "Not charged",
};

/** One row of the item table, filled from the records when the answer is saved. */
export interface MoneyTableRow {
  /** `side:itemId`, as the model names the item. */
  key: string;
  label: string;
  status: MoneyStatus;
  heldCents: number;
  chargedCents: number;
  refundedCents: number;
  releasedCents: number;
  /** What the confirmed version keeps from this item's money and does not refund, such as a restocking fee. */
  nonRefundableCents: number;
  /** What makes up nonRefundableCents, by type; empty or absent when the version states only a total. */
  nonRefundableFees?: NonRefundableFee[];
  /** Charged less refunded. */
  netCents: number;
  /** The facts about this item; a sentence about it is checked against all of them. */
  factIds: string[];
}

export type MoneyItem = MoneyTableRow;

/** One sentence of Setti's written answer and the recorded facts it rests on. */
export interface MoneyAnswerSentence {
  text: string;
  /** Facts it cites by id, including any warning it addresses. */
  factIds: string[];
  /** The item keys it talks about, or "project"; every record of those is its evidence. Absent in older answers. */
  about?: string[];
}

/** Setti's answer as the model returns it: the items to tabulate and the sentences around them. */
export interface MoneyAnswerDraft {
  summary: MoneyAnswerSentence;
  /** Item keys for the table, in reading order. */
  items: string[];
  notes: MoneyAnswerSentence[];
}

/** One item's line in an older answer, written by the model itself; newer answers keep `rows` empty and use the table. */
export interface MoneyAnswerRow {
  label: string;
  status: string;
  amount: string | null;
  factIds: string[];
}

/** Setti's answer as it chose to lay it out: the conclusion, item lines when several items matter, then short notes. */
export interface MoneyAnswerBody {
  summary: MoneyAnswerSentence;
  rows: MoneyAnswerRow[];
  notes: MoneyAnswerSentence[];
}

/** Stored with the reply so a later transaction cannot rewrite an earlier answer. */
export interface MoneyAnswer {
  quoteId: string;
  version: number;
  checkedAt: string;
  providerRecordedAt: string | null;
  mode: "recorded_sandbox";
  facts: MoneyFact[];
  sources: MoneySource[];
  /** Setti's verified answer; absent when the recorded facts are shown on their own. */
  answer?: MoneyAnswerBody;
  /** The item table, built from the records when the answer was saved; absent in older answers. */
  table?: MoneyTableRow[];
  /** Setti chose to show the cited records because the person asked for the evidence. */
  showEvidence?: boolean;
}
