/**
 * The demo's sample project, as data. A demo studio gets it the first time it
 * opens it; a real studio only has the projects its designers create. Maple
 * starts from a V1 its client approved before the project came to Setti.
 */
import type { CaseKey } from "@/chat/types";
import type { ProjectQuote, ProjectStart } from "@/projects/settings";
import { mapleApprovedQuote } from "@/quotes/demo-quote";
import { HOME_APPROVED_QUOTE } from "./living-dining";

export interface ProjectSeed {
  name: string;
  subtitle: string;
  startsFrom: ProjectStart;
  quote: ProjectQuote;
}

const SAMPLES: Record<string, ProjectSeed> = {
  maple: { name: "Maple Ave Café", subtitle: "Counter and back bar", startsFrom: "approved_quote", quote: mapleApprovedQuote },
};

/** The sample project with this key, or null. */
export function sampleProject(key: CaseKey): ProjectSeed | null {
  return SAMPLES[key] ?? null;
}

/** The Maple project /try prepares: the café counter and back bar, approved before Setti. */
export const TRY_PROJECT: ProjectSeed = { ...SAMPLES.maple, quote: HOME_APPROVED_QUOTE };
