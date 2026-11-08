/**
 * The prepared studio projects on the desk. Their money is example data from
 * STUDIO_CASES, shown with the same parts and words as live projects.
 */
import { STUDIO_CASES } from "@/demo/studio-cases";
import { STUDIO_STAGES, studioLineTotal, studioQuoteTotal, type StudioCase, type StudioLine, type StudioMoneyLine } from "@/demo/studio-types";
import type { DeskItem, DeskProject } from "./types";

const NONE: StudioMoneyLine = { lineId: "", heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 0, awaitingCreditCents: 0 };

function item(project: StudioCase, line: StudioLine, agreed: boolean): DeskItem {
  const money = project.money.find((entry) => entry.lineId === line.id) ?? NONE;
  const base = {
    id: line.id, name: line.name, category: line.kind === "Design service" ? "service" as const : "furniture" as const,
    agreedCents: agreed ? studioLineTotal(line) : 0,
    heldCents: money.heldCents, chargedCents: money.capturedCents, refundedCents: money.refundedCents, toRefundCents: money.awaitingCreditCents,
  };
  if (money.awaitingCreditCents > 0) return { ...base, status: "Awaiting supplier credit", next: "Record the supplier credit, then refund the client.", waitingOn: "designer" };
  if (money.heldCents > 0) return { ...base, status: "Awaiting supplier confirmation", next: "Record the supplier’s confirmation, then charge.", waitingOn: "designer" };
  if (money.refundedCents > 0) return { ...base, status: "Refund completed", next: "Nothing to do.", waitingOn: null };
  if (money.capturedCents > 0) return { ...base, status: "Payment completed", next: "Nothing to do.", waitingOn: null };
  if (!agreed) return { ...base, status: "Not requested", next: "The quote has not been sent yet.", waitingOn: null };
  return { ...base, status: "Not funded yet", next: "Waits for the client.", waitingOn: "client" };
}

export function exampleProject(project: StudioCase): DeskProject {
  const agreed = project.quote.status === "approved";
  const pending = project.proposal && project.proposal.status === "awaiting_client" ? project.proposal : null;
  return {
    id: project.id, name: project.name, client: project.client.name, source: "example",
    stage: STUDIO_STAGES[project.stage].label,
    version: agreed ? project.quote.version : null,
    agreedCents: agreed ? studioQuoteTotal(project.quote) : null,
    proposedCents: pending ? studioQuoteTotal(pending) : agreed ? null : studioQuoteTotal(project.quote),
    items: project.quote.lines.map((line) => item(project, line, agreed)),
    href: `/chats/${project.id}`,
  };
}

export function exampleProjects(): DeskProject[] {
  return STUDIO_CASES.map(exampleProject);
}
