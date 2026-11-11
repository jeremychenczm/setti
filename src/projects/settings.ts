/**
 * What a project is set up as. Product code asks these questions of the
 * project's own row, never of its name: whether its V1 starts as a draft the
 * designer sends from the chat, or as a quote the client approved before Setti.
 */
import type { ApprovedQuoteReport, QuoteDocument } from "@/quotes/types";

export type ProjectStart = "draft_quote" | "approved_quote";
export const PROJECT_STARTS = ["draft_quote", "approved_quote"] as const satisfies readonly ProjectStart[];

/** A project's quote as stored: the V1 being prepared, or the V1 approved before Setti. */
export type ProjectQuote = QuoteDocument | ApprovedQuoteReport;

export interface ProjectSettings {
  startsFrom: ProjectStart;
  quote: ProjectQuote;
}

/** The designer sends this project's V1 from the chat, and the client decides on it line by line. */
export function sentFromChat(project: Pick<ProjectSettings, "startsFrom">): boolean {
  return project.startsFrom === "draft_quote";
}

/** The V1 the client approved before the project came to Setti, or null when V1 is sent from the chat. */
export function approvedStart(project: ProjectSettings): ApprovedQuoteReport | null {
  return project.startsFrom === "approved_quote" && "status" in project.quote && project.quote.status === "approved" ? project.quote : null;
}

/** The designer the project's quote names, without the demo's "(demo designer)" note. */
export function quoteDesignerName(quote: Pick<ProjectQuote, "designerName">): string {
  return quote.designerName.replace(/\s*\(demo designer\)$/, "");
}

/** The project's V1 lines as prepared, without an approval. */
export function preparedQuote(project: ProjectSettings): ProjectQuote {
  return project.quote;
}
