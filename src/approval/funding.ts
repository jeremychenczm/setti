import { planChange } from "../money/plan";
import { calculateLineTotals, calculateQuoteTotals } from "../quotes/totals";
import type { FrozenChangeOrder, ReviewedChange } from "../pricing/types";
import type { ItemCategory } from "../money/types";

export interface FundingLineFact {
  /** Frozen document item identity, mapped from the business item UUID by the caller. */
  itemId: string;
  /** Replacements keep a document item ID but use different business items. */
  side?: "baseline" | "proposed";
  /** Available hold after completed captures, closed holds and expiration are accounted for. */
  heldCents: number;
  capturedCents: number;
  refundedCents: number;
  /** Pending/unknown provider results must never become zero or settled money. */
  uncertainReason?: string;
  vendorCreditConfirmed?: boolean;
  /** The studio cancelled this item before it was charged: its target is zero, whatever the document assigns. */
  cancelled?: boolean;
}

export interface FundingFacts {
  status: "no_records" | "recorded";
  checkedAt: string;
  lines: readonly FundingLineFact[];
  /** Unallocated project funds, unresolved operations or unverified provider state. */
  blockers?: readonly string[];
}

export interface FundingAction {
  kind: "new_authorization" | "release_authorization" | "capture" | "refund";
  itemId: string;
  side: "baseline" | "proposed";
  label: string;
  amountCents: number;
  timing: "on_payment_execution" | "after_vendor_confirmation" | "after_vendor_credit";
  reason: string;
}

/** One funding group of the frozen document with the money recorded against it. */
export interface FundingLine {
  itemId: string;
  side: "baseline" | "proposed";
  label: string;
  category: ItemCategory;
  /** True for lines this version changes; unchanged lines carry over from the baseline. */
  changed: boolean;
  /** The change that produced the line: the old product of a replacement is `replace` on the baseline side. */
  change: ReviewedChange["action"] | null;
  /** The complete reviewed amount this version assigns to the line, including retained old-item costs; zero once the studio cancelled the item. */
  targetCents: number;
  /** What the document assigned before the studio cancelled the item; present only for a cancelled item. */
  cancelledTargetCents?: number;
  heldCents: number;
  capturedCents: number;
  refundedCents: number;
}

export interface FundingPlan {
  orderId: string;
  contentHash: string;
  basedOnVersion: number;
  version: number;
  quoteDeltaCents: number;
  factsAsOf: string;
  status: "not_authorized" | "preview" | "blocked";
  executable: false;
  current: { heldCents: number; capturedCents: number; refundedCents: number };
  money: {
    newAuthorizationCents: number | null;
    releaseCents: number | null;
    chargeCents: number | null;
    refundCents: number | null;
  };
  /** Every funding group with its target and recorded money; empty when the document cannot be read. */
  lines: FundingLine[];
  actions: FundingAction[];
  blockers: string[];
  notices: string[];
}

interface Group {
  itemId: string;
  side: "baseline" | "proposed";
  label: string;
  category: ItemCategory;
  targetCents: number;
  changed: boolean;
  change: ReviewedChange["action"] | null;
  handling?: ReviewedChange["oldItemHandling"];
}

const key = (itemId: string, side: "baseline" | "proposed") => JSON.stringify([side, itemId]);
const zeroMoney = () => ({ newAuthorizationCents: 0, releaseCents: 0, chargeCents: 0, refundCents: 0 });
const emptyFact = (group: Group): FundingLineFact => ({ itemId: group.itemId, side: group.side, heldCents: 0, capturedCents: 0, refundedCents: 0 });

function cents(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function sum(values: readonly number[]): number {
  const value = values.reduce((total, amount) => total + amount, 0);
  if (!cents(value)) throw new Error("Funding amounts exceed the safe integer range.");
  return value;
}

/** What a plan is for: the frozen document (or V1) it funds and its version. */
interface PlanHeader {
  orderId: string;
  contentHash: string;
  basedOnVersion: number;
  version: number;
  quoteDeltaCents: number;
}

/** The funding groups of a document, and which baseline items it changes. */
interface Groups {
  groups: Group[];
  changedItems: ReadonlySet<string>;
}

const PREVIEW_NOTICE = "This is a payment plan preview. No authorization, charge, release or refund has been executed.";
const VENDOR_NOTICE = "Authorization and capture are separate steps. Product funding remains subject to vendor confirmation.";

/** Old-item handlings whose refund waits until the supplier's credit is recorded. */
export const REFUND_AFTER_CREDIT: readonly ReviewedChange["oldItemHandling"][] = ["cancelled", "modified", "returned"];

/**
 * Pure, conservative preview. It never calls PayPal or treats approval as payment.
 * The document supplies its frozen baseline; money facts must be mapped to that
 * baseline or the proposed product, rather than to names or row positions.
 */
export function buildFundingPlan(order: FrozenChangeOrder, facts: FundingFacts): FundingPlan {
  return planFunding(
    { orderId: order.id, contentHash: order.contentHash, basedOnVersion: order.basedOnVersion, version: order.version, quoteDeltaCents: order.deltaTotalCents },
    facts, [PREVIEW_NOTICE, "The quote difference is a budget change, not an amount to pay now.", VENDOR_NOTICE], () => documentGroups(order),
  );
}

/** One approved line of a V1 signed line by line. */
export interface OpeningFundingLine {
  itemId: string;
  label: string;
  category: ItemCategory;
  targetCents: number;
}

/**
 * The same preview for a V1 signed line by line: every approved line is funded
 * in full under the same furniture and service rules. Declined and undecided
 * lines are not part of the agreement, so they are never funded.
 */
export function buildOpeningPlan(opening: { id: string; contentHash: string }, lines: readonly OpeningFundingLine[], facts: FundingFacts): FundingPlan {
  return planFunding(
    { orderId: opening.id, contentHash: opening.contentHash, basedOnVersion: 0, version: 1, quoteDeltaCents: lines.reduce((total, line) => total + line.targetCents, 0) },
    facts, [PREVIEW_NOTICE, VENDOR_NOTICE],
    () => ({ groups: lines.map((line) => ({ itemId: line.itemId, side: "baseline", label: line.label, category: line.category, targetCents: line.targetCents, changed: false, change: null })), changedItems: new Set() }),
  );
}

/** The funding groups of a frozen change order; throws when its lines and changes cannot be matched exactly. */
function documentGroups(order: FrozenChangeOrder): Groups {
  const groups: Group[] = [];
  const baseline = new Map(order.baselineLines.map((line) => [line.itemId, line]));
  const proposed = new Map(order.lines.map((line) => [line.itemId, line]));
  const changes = new Map(order.changes.filter((change) => change.itemId !== null).map((change) => [change.itemId!, change]));
  if (baseline.size !== order.baselineLines.length || proposed.size !== order.lines.length ||
      changes.size !== order.changes.filter((change) => change.itemId !== null).length) {
    throw new Error("The frozen document contains duplicate quote or change identities.");
  }
  if (calculateQuoteTotals(order.lines).totalCents !== order.totals.totalCents ||
      calculateQuoteTotals(order.baselineLines).totalCents !== order.baselineTotals.totalCents ||
      order.totals.totalCents - order.baselineTotals.totalCents !== order.deltaTotalCents) {
    throw new Error("The frozen quote totals do not match its line amounts.");
  }

  const consumed = new Set<string>();
  for (const before of order.baselineLines) {
    const change = changes.get(before.itemId);
    const after = proposed.get(before.itemId);
    if (!change) {
      if (!after) throw new Error("An unchanged baseline item is missing from the proposed quote.");
      groups.push({ itemId: before.itemId, side: "baseline", label: after.name, category: after.category, targetCents: calculateLineTotals(after).totalCents, changed: false, change: null });
      consumed.add(after.itemId);
      continue;
    }
    const feeId = `old-cost-${order.sourceDraftId}-${change.key}`;
    const fee = proposed.get(feeId);
    if (change.oldItemCostCents > 0) {
      if (!fee || fee.origin !== "old_item_cost" || calculateLineTotals(fee).totalCents !== change.oldItemCostCents) {
        throw new Error("The reviewed old-item cost cannot be matched to one frozen fee line.");
      }
      consumed.add(feeId);
    } else if (fee) {
      throw new Error("An unexpected old-item fee line needs review.");
    }
    if (change.action === "replace" || change.action === "remove") {
      groups.push({ itemId: before.itemId, side: "baseline", label: before.name, category: change.oldItemHandling === "retained" ? before.category : "service", targetCents: change.oldItemCostCents, changed: true, change: change.action, handling: change.oldItemHandling });
      if (change.action === "replace") {
        if (!after || !change.after) throw new Error("The replacement product is missing from the frozen quote.");
        groups.push({ itemId: after.itemId, side: "proposed", label: after.name, category: after.category, targetCents: calculateLineTotals(after).totalCents, changed: true, change: "replace" });
        consumed.add(after.itemId);
      } else if (after) throw new Error("A removed item still appears in the proposed quote.");
    } else if (change.action === "quantity") {
      if (!after) throw new Error("The changed quantity is missing from the frozen quote.");
      groups.push({ itemId: before.itemId, side: "baseline", label: after.name, category: after.category, targetCents: sum([calculateLineTotals(after).totalCents, change.oldItemCostCents]), changed: true, change: "quantity", handling: change.oldItemHandling });
      consumed.add(after.itemId);
    } else {
      throw new Error("An existing item has an unsupported change type.");
    }
  }
  for (const change of order.changes) {
    if (change.itemId !== null && !baseline.has(change.itemId)) throw new Error("A change refers to an unknown baseline item.");
  }
  for (const line of order.lines) {
    if (consumed.has(line.itemId)) continue;
    const addition = order.changes.find((change) => change.action === "add" && change.after?.itemId === line.itemId);
    if (!addition || baseline.has(line.itemId)) throw new Error("A proposed line cannot be matched to its frozen change.");
    groups.push({ itemId: line.itemId, side: "proposed", label: line.name, category: line.category, targetCents: calculateLineTotals(line).totalCents, changed: true, change: "add" });
    consumed.add(line.itemId);
  }
  if (sum(groups.map((group) => group.targetCents)) !== order.totals.totalCents) throw new Error("Funding targets do not reconcile to the complete proposed quote.");
  return { groups, changedItems: new Set(changes.keys()) };
}

function planFunding(header: PlanHeader, facts: FundingFacts, notices: string[], readGroups: () => Groups): FundingPlan {
  const blockers = [...(facts.blockers ?? [])];
  const result: FundingPlan = {
    ...header, factsAsOf: facts.checkedAt,
    status: facts.status === "no_records" ? "not_authorized" : "preview", executable: false,
    current: { heldCents: 0, capturedCents: 0, refundedCents: 0 },
    money: zeroMoney(), lines: [], actions: [], blockers, notices,
  };
  const grouped = new Set<string>();
  const byFact = new Map<string, FundingLineFact>();

  try {
    if (!Number.isFinite(Date.parse(facts.checkedAt))) blockers.push("The funding facts need a valid check time.");
    if (!["no_records", "recorded"].includes(facts.status)) blockers.push("The funding facts status is invalid.");
    if (facts.status === "no_records" && facts.lines.length) blockers.push("Funding records were supplied with a no-records status.");
    const { groups, changedItems } = readGroups();
    for (const group of groups) {
      const id = key(group.itemId, group.side);
      if (grouped.has(id)) throw new Error("The frozen document contains duplicate funding identities.");
      if (!cents(group.targetCents)) throw new Error("A funding target is not a safe non-negative cent amount.");
      grouped.add(id);
    }

    for (const fact of facts.lines) {
      const side = fact.side ?? "baseline";
      const id = key(fact.itemId, side);
      if (side !== "baseline" && side !== "proposed") { blockers.push("A funding record has an invalid side."); continue; }
      if (byFact.has(id)) { blockers.push("Multiple funding records map to the same item and side; aggregate each business item exactly once."); continue; }
      if (!grouped.has(id)) { blockers.push("A funding record cannot be attributed to this frozen quote."); continue; }
      if (![fact.heldCents, fact.capturedCents, fact.refundedCents].every(cents) || fact.refundedCents > fact.capturedCents) {
        blockers.push("A funding record has invalid amounts or refunds above completed captures."); continue;
      }
      byFact.set(id, fact);
      if (fact.uncertainReason?.trim()) blockers.push(fact.uncertainReason.trim());
    }
    result.current = {
      heldCents: sum([...byFact.values()].map((fact) => fact.heldCents)),
      capturedCents: sum([...byFact.values()].map((fact) => fact.capturedCents)),
      refundedCents: sum([...byFact.values()].map((fact) => fact.refundedCents)),
    };
    // A cancelled item is funded by nothing: what it still holds is released, and it is never held again.
    const target = (group: Group) => byFact.get(key(group.itemId, group.side))?.cancelled ? 0 : group.targetCents;
    result.lines = groups.map((group) => {
      const fact = byFact.get(key(group.itemId, group.side)) ?? emptyFact(group);
      return { itemId: group.itemId, side: group.side, label: group.label, category: group.category, changed: group.changed, change: group.change, targetCents: target(group),
        ...(fact.cancelled ? { cancelledTargetCents: group.targetCents } : {}), heldCents: fact.heldCents, capturedCents: fact.capturedCents, refundedCents: fact.refundedCents };
    });
    if (blockers.length) throw new Error("Resolve the funding blockers before calculating payment actions.");

    const push = (group: Group, kind: FundingAction["kind"], amountCents: number, timing: FundingAction["timing"], reason: string) => {
      if (amountCents === 0) return;
      if (!cents(amountCents)) throw new Error("A payment action amount is invalid.");
      result.actions.push({ itemId: group.itemId, side: group.side, label: group.label, kind, amountCents, timing, reason });
    };
    for (const group of groups) {
      const fact = byFact.get(key(group.itemId, group.side)) ?? emptyFact(group);
      const paid = fact.capturedCents - fact.refundedCents;
      const targetCents = target(group);
      const remaining = Math.max(targetCents - paid, 0);
      if (paid > targetCents) {
        const conditional = !!group.handling && REFUND_AFTER_CREDIT.includes(group.handling) && !fact.vendorCreditConfirmed;
        if (group.handling === "pending" || group.handling === "not_applicable" && group.side === "baseline" && changedItems.has(group.itemId)) {
          throw new Error("A captured item reduction needs a confirmed old-item handling decision.");
        }
        push(group, "refund", paid - targetCents, conditional ? "after_vendor_credit" : "on_payment_execution",
          conditional ? "Refund only after the vendor credit is verified; the reviewed retained cost is deducted once." : "Refund completed captures above the reviewed target after subtracting prior refunds and retained costs.");
      }
      if (fact.heldCents > remaining) {
        const release = fact.heldCents - remaining;
        push(group, "release_authorization", release, remaining > 0 ? "after_vendor_confirmation" : "on_payment_execution",
          remaining > 0 ? "The excess is released only when the remaining authorized amount is captured and the hold is closed." : "Close the unused authorization; this is a release, not a refund.");
        if (remaining > 0) push(group, "capture", remaining, "after_vendor_confirmation", "Capture only the reviewed remaining amount, then close the hold to release the excess.");
      } else if (fact.heldCents > 0 && group.category === "service" && (group.change === null || group.change === "add" || group.change === "quantity")) {
        push(group, "capture", fact.heldCents, "on_payment_execution", "Capture the held design service; no supplier confirms a studio's own service.");
      } else if (fact.heldCents > 0) {
        push(group, "capture", fact.heldCents, "after_vendor_confirmation", "Capture the authorized amount only after the supplier confirms the reviewed order.");
      }
      const unfunded = Math.max(remaining - fact.heldCents, 0);
      if (unfunded > 0) {
        // Reuse the existing furniture/service policy. Do not derive percentage
        // return costs again: the frozen document already carries the exact cost.
        const planned = planChange([], [{ type: "add", lineId: group.itemId, label: group.label, category: group.category, priceCents: unfunded }], { hasVault: false });
        const action = planned.actions[0];
        if (action.kind === "new_authorization") push(group, "new_authorization", unfunded, "on_payment_execution", "The complete approved target is not covered by settled captures or available holds; establish this additional furniture authorization.");
        else if (action.kind === "immediate_capture") push(group, "capture", unfunded, "on_payment_execution", "This approved service or old-item cost is not covered by settled payments and requires a separate payment step.");
        else throw new Error("The money rules returned an unsupported funding action.");
      }
    }
    result.money = {
      newAuthorizationCents: sum(result.actions.filter((action) => action.kind === "new_authorization").map((action) => action.amountCents)),
      releaseCents: sum(result.actions.filter((action) => action.kind === "release_authorization").map((action) => action.amountCents)),
      chargeCents: sum(result.actions.filter((action) => action.kind === "capture").map((action) => action.amountCents)),
      refundCents: sum(result.actions.filter((action) => action.kind === "refund").map((action) => action.amountCents)),
    };
    if (facts.status === "no_records") notices.push("No PayPal funding records exist for this project. The full proposed quote still needs funding; no old money can be released or refunded.");
    if (result.actions.some((action) => action.timing === "after_vendor_credit")) notices.push("A conditional refund is a proposed action, not a promise that a vendor credit or refund has already occurred.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The payment plan needs manual review.";
    if (!blockers.length || message !== "Resolve the funding blockers before calculating payment actions.") blockers.push(message);
    result.status = "blocked";
    result.actions = [];
    result.money = { newAuthorizationCents: null, releaseCents: null, chargeCents: null, refundCents: null };
  }
  return result;
}
