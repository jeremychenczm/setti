import { sampleProject } from "@/demo/sample-projects";
import { approvedStart } from "@/projects/settings";
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";
import type { CaseKey } from "./types";

export const PROJECT_KEY_MAX = 48;
const PROJECT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A well-formed project short name. Whether the project exists is the studio's to say. */
export function isCaseKey(value: string): value is CaseKey {
  return value.length <= PROJECT_KEY_MAX && PROJECT_KEY.test(value);
}

/** The sample project's V1 (demo data, for tests and seeding). Product code reads the project's own row. */
export function caseDocument(key: CaseKey): QuoteDocument {
  const sample = sampleProject(key);
  if (!sample) throw new Error(`There is no sample project "${key}".`);
  return sample.quote;
}

/** The sample project's V1 approved before Setti, or null when it starts from a draft (demo data). */
export function preapprovedQuote(key: CaseKey): ApprovedQuoteReport | null {
  const sample = sampleProject(key);
  return sample ? approvedStart(sample) : null;
}
