/**
 * The designer's money desk: where client money stands in every project, item
 * by item. Every amount comes from recorded facts (live projects) or prepared
 * example data; nothing here is written by a model.
 */

/** Whose step an item waits for. */
export type DeskWaitingOn = "designer" | "client" | null;

export interface DeskItem {
  id: string;
  name: string;
  category: "furniture" | "service";
  /** What the latest agreement assigns to the item. */
  agreedCents: number;
  heldCents: number;
  /** Completed captures, before refunds. */
  chargedCents: number;
  refundedCents: number;
  /** Charged money that goes back to the client once a supplier credit lands or the refund runs. */
  toRefundCents: number;
  /** The item's state in the words the payments page uses. */
  status: string;
  next: string;
  waitingOn: DeskWaitingOn;
}

export interface DeskProject {
  id: string;
  name: string;
  client: string;
  /** Live projects are this browser's real Sandbox records; examples are prepared data. */
  source: "live" | "example";
  stage: string;
  /** The agreement's version, or null while nothing is agreed. */
  version: number | null;
  /** The agreed total, or null while nothing is agreed. */
  agreedCents: number | null;
  /** A quote still with the client (a first quote, or a revision awaiting confirmation). */
  proposedCents: number | null;
  items: DeskItem[];
  /** Where the project's payments are shown. */
  href: string;
}

export interface MoneyDesk {
  checkedAt: string;
  projects: DeskProject[];
}

/** One project's money in the desk's five parts. */
export interface DeskTotals {
  /** Charged and kept: completed captures less refunds and money still to refund. */
  keptCents: number;
  heldCents: number;
  toRefundCents: number;
  refundedCents: number;
  chargedCents: number;
  /** Agreed but neither kept nor held yet. */
  notFundedCents: number;
  /** Items that wait for the designer. */
  needsYou: number;
}

const sum = (items: readonly DeskItem[], key: "heldCents" | "chargedCents" | "refundedCents" | "toRefundCents") =>
  items.reduce((total, item) => total + item[key], 0);

export function deskTotals(project: DeskProject): DeskTotals {
  const chargedCents = sum(project.items, "chargedCents"), refundedCents = sum(project.items, "refundedCents");
  const toRefundCents = sum(project.items, "toRefundCents"), heldCents = sum(project.items, "heldCents");
  const keptCents = chargedCents - refundedCents - toRefundCents;
  return {
    keptCents, heldCents, toRefundCents, refundedCents, chargedCents,
    notFundedCents: project.agreedCents === null ? 0 : Math.max(project.agreedCents - keptCents - heldCents, 0),
    needsYou: project.items.filter((item) => item.waitingOn === "designer").length,
  };
}
