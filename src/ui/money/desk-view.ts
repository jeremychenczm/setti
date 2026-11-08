/**
 * What the money desk draws, worked out from the server's desk: the totals,
 * each project's Confetti blocks, what needs the designer, and how the selected
 * project adds up. Pure, so every number on the page is tested here.
 */
import { deskTotals, type DeskItem, type DeskProject, type DeskTotals, type MoneyDesk } from "@/money-desk/types";

export type MoneyPart = "kept" | "held" | "toRefund" | "refunded" | "notFunded";

/** The Confetti palette: Setti yellow for charged money, deep red for holds waiting on you, coral and violet for money going back. */
export const PARTS: readonly { id: MoneyPart; label: string; fill: string; ink: string; soft: string; softInk: string }[] = [
  { id: "kept", label: "Charged", fill: "#ffcc70", ink: "#292e24", soft: "#fff1d6", softInk: "#8c5b17" },
  { id: "held", label: "On hold", fill: "#d7262e", ink: "#ffffff", soft: "#fde4e4", softInk: "#a3161d" },
  { id: "toRefund", label: "To refund", fill: "#f7a6a0", ink: "#292e24", soft: "#fdeceb", softInk: "#9c3d34" },
  { id: "refunded", label: "Refunded", fill: "#5b3d9a", ink: "#ffffff", soft: "#ece7f6", softInk: "#4a2f84" },
  { id: "notFunded", label: "Not funded", fill: "#ebe9e2", ink: "#7b7f73", soft: "#f7f6f2", softInk: "#7b7f73" },
];
export const part = (id: MoneyPart) => PARTS.find((entry) => entry.id === id)!;

export type DeskFilter = "all" | "live" | "example";

export function visibleProjects(desk: MoneyDesk, filter: DeskFilter): DeskProject[] {
  return desk.projects.filter((project) => filter === "all" || project.source === filter);
}

export function filterCounts(desk: MoneyDesk): Record<DeskFilter, number> {
  return { all: desk.projects.length, live: desk.projects.filter((p) => p.source === "live").length, example: desk.projects.filter((p) => p.source === "example").length };
}

export interface DeskSummary {
  heldCents: number; chargedCents: number; refundedCents: number; toRefundCents: number;
  /** How many shown projects have any of each, for the card's corner. */
  projectsWith: { held: number; charged: number; refunded: number; toRefund: number };
}

export function summary(projects: readonly DeskProject[]): DeskSummary {
  const totals = projects.map(deskTotals);
  const sum = (key: keyof DeskTotals) => totals.reduce((total, entry) => total + entry[key], 0);
  const count = (key: keyof DeskTotals) => totals.filter((entry) => entry[key] > 0).length;
  return {
    heldCents: sum("heldCents"), chargedCents: sum("chargedCents"), refundedCents: sum("refundedCents"), toRefundCents: sum("toRefundCents"),
    projectsWith: { held: count("heldCents"), charged: count("chargedCents"), refunded: count("refundedCents"), toRefund: count("toRefundCents") },
  };
}

export interface Block { part: MoneyPart; cents: number; share: number }

/** One project's bar: its money in the five parts, as shares of the widest project shown; a quote not agreed yet is an outline. */
export function projectBar(project: DeskProject, scale: number): { blocks: Block[]; proposedShare: number | null } {
  if (project.agreedCents === null) return { blocks: [], proposedShare: scale ? (project.proposedCents ?? 0) / scale : 0 };
  const t = deskTotals(project);
  const parts: [MoneyPart, number][] = [["kept", t.keptCents], ["held", t.heldCents], ["toRefund", t.toRefundCents], ["refunded", t.refundedCents], ["notFunded", t.notFundedCents]];
  return { blocks: parts.filter(([, cents]) => cents > 0).map(([id, cents]) => ({ part: id, cents, share: scale ? cents / scale : 0 })), proposedShare: null };
}

export function barScale(projects: readonly DeskProject[]): number {
  return Math.max(0, ...projects.map((project) => {
    const t = deskTotals(project);
    return Math.max(project.agreedCents ?? 0, project.proposedCents ?? 0, t.chargedCents + t.heldCents);
  }));
}

/** The item's dominant part, which colours its status. */
export function itemPart(item: DeskItem): MoneyPart {
  if (item.toRefundCents > 0) return "toRefund";
  if (item.heldCents > 0) return "held";
  if (item.refundedCents > 0) return "refunded";
  if (item.chargedCents > 0) return "kept";
  return "notFunded";
}

export function itemBlocks(item: DeskItem): Block[] {
  const total = Math.max(item.chargedCents + item.heldCents, item.agreedCents, 1);
  const parts: [MoneyPart, number][] = [["kept", item.chargedCents - item.refundedCents - item.toRefundCents], ["held", item.heldCents], ["toRefund", item.toRefundCents], ["refunded", item.refundedCents]];
  return parts.filter(([, cents]) => cents > 0).map(([id, cents]) => ({ part: id, cents, share: cents / total }));
}

export interface NeedRow { projectId: string; project: string; item: string; amountCents: number; part: MoneyPart; action: string }

/** Every item waiting for the designer, with the money its next step moves. */
export function needs(projects: readonly DeskProject[]): NeedRow[] {
  return projects.flatMap((project) => project.items.filter((item) => item.waitingOn === "designer").map((item) => {
    const kind = itemPart(item);
    const action = item.toRefundCents > 0 ? "record the credit, then refund" : item.status === "Ready for capture" ? "charge" : item.heldCents > 0 ? "confirm, then charge" : item.status.toLowerCase();
    return { projectId: project.id, project: project.name, item: item.name, amountCents: item.toRefundCents || item.heldCents, part: kind, action };
  }));
}

export interface WaterStep { label: string; cents: number; sign: 1 | -1; part: MoneyPart; from: number; to: number }

/** Charged − refunded − to refund + on hold + not funded = agreed: the project's two sides meeting. */
export function waterfall(project: DeskProject): { steps: WaterStep[]; total: number; agreed: boolean; peak: number } {
  const t = deskTotals(project);
  let level = 0;
  const steps = ([["Charged", t.chargedCents, 1, "kept"], ["Refunded", t.refundedCents, -1, "refunded"], ["To refund", t.toRefundCents, -1, "toRefund"], ["On hold", t.heldCents, 1, "held"], ["Not funded", t.notFundedCents, 1, "notFunded"]] as const)
    .map(([label, cents, sign, id]) => { const from = level; level += cents * sign; return { label, cents, sign, part: id, from, to: level }; });
  const total = project.agreedCents ?? project.proposedCents ?? 0;
  return { steps, total, agreed: project.agreedCents !== null, peak: Math.max(t.chargedCents, total, 1) };
}

export function defaultSelection(projects: readonly DeskProject[]): string | null {
  return (projects.find((project) => project.source === "live") ?? projects.find((project) => deskTotals(project).needsYou > 0) ?? projects[0])?.id ?? null;
}

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
export const shortUsd = (cents: number) => cents >= 100_000 ? `$${(cents / 100_000).toFixed(1).replace(".0", "")}k` : `$${Math.round(cents / 100)}`;
