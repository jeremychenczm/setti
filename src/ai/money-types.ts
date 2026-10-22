import type { CaseKey } from "../chat/types";

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
}
