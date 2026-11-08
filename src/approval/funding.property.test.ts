/**
 * Property tests for the funding planner: instead of hand-picked examples,
 * fast-check generates random approved quotes (a V1 signed line by line, or a
 * V2 change order) and random money already held, captured and refunded, and
 * every plan must keep the same money rules.
 * A failure prints the seed and path; pass them to `fc.assert` to replay it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFundingPlan, buildOpeningPlan, type FundingFacts, type FundingLine, type FundingLineFact, type FundingPlan, type OpeningFundingLine } from "./funding";
import { calculateLineTotals, calculateQuoteTotals } from "../quotes/totals";
import type { ApprovedQuoteLine } from "../quotes/types";
import type { FinalQuoteLine, FrozenChangeOrder, OldItemHandling, ReviewedChange } from "../pricing/types";

const RUNS = { numRuns: 1000 };
const MAX_CENTS = 2_000_000; // $20,000
const checkedAt = "2026-10-20T11:00:00.000Z";

type Side = FundingLine["side"];
const key = (itemId: string, side: Side = "baseline") => `${side}:${itemId}`;

/** One generated case: the document, the money recorded against it, and what the document should fund. */
interface Case<Doc> {
  doc: Doc;
  facts: FundingFacts;
  /** Approved target per funding line, before any cancellation. */
  targets: ReadonlyMap<string, number>;
  /** Old-item handling of each changed baseline line. */
  handlings: ReadonlyMap<string, OldItemHandling>;
}

// ---------------------------------------------------------------- money generators

/** Whole cents, with zero and the line's own target over-represented so the equal-amount edges come up often. */
const amountNear = (target: number) => fc.oneof(
  fc.constant(0),
  fc.constant(target),
  fc.integer({ min: 0, max: target }),
  fc.integer({ min: 0, max: MAX_CENTS }),
);

/** Money recorded against one line; refunds never exceed captures, as PayPal guarantees. */
const recordedMoney = (target: number) => amountNear(target).chain((captured) => fc.record({
  heldCents: amountNear(target),
  capturedCents: fc.constant(captured),
  refundedCents: fc.oneof(fc.constant(0), fc.constant(captured), fc.integer({ min: 0, max: captured })),
  cancelled: fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
  vendorCreditConfirmed: fc.boolean(),
}));

const category = fc.constantFrom("furniture" as const, "service" as const);

// ---------------------------------------------------------------- V1 signed line by line

const opening = { id: "v1-revision", contentHash: "a".repeat(64) };

const openingLineSpec = fc.record({
  category,
  targetCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: MAX_CENTS })),
}).chain((line) => fc.record({
  line: fc.constant(line),
  money: fc.option(recordedMoney(line.targetCents), { nil: undefined, freq: 5 }),
}));

/** 1 to 8 approved lines, some with no money recorded yet. */
const openingCase: fc.Arbitrary<Case<OpeningFundingLine[]>> = fc.array(openingLineSpec, { minLength: 1, maxLength: 8 }).map((specs) => {
  const doc = specs.map(({ line }, i) => ({ itemId: `item-${i}`, label: `Item ${i}`, ...line }));
  const recorded: FundingLineFact[] = specs.flatMap(({ money }, i) => money ? [{ itemId: `item-${i}`, ...money }] : []);
  return {
    doc,
    facts: { status: recorded.length ? "recorded" : "no_records", checkedAt, lines: recorded },
    targets: new Map(doc.map((line) => [key(line.itemId), line.targetCents])),
    handlings: new Map(),
  };
});

// ---------------------------------------------------------------- V2 change order

const DRAFT = "draft-1";
const approvedTemplate: ApprovedQuoteLine = {
  itemId: "", name: "", vendor: "Vendor", category: "furniture", room: "Living",
  sku: "sku", specification: "Checked", quantity: 1, unitLabel: "each",
  unitPriceCents: 0, taxCents: 0, freightCents: 0,
  source: { kind: "demo", reference: "ref", name: "Original quote", note: "demo" },
  leadTimeDays: null, returnPolicy: "Checked", restockingFeeBps: null, customMade: false, nonReturnable: false,
  approval: { status: "approved", approvedBy: "Client", approvedAt: "2026-10-20T10:00:00.000Z", signature: "Demo Client", isDemo: true },
};
const finalTemplate: FinalQuoteLine = {
  itemId: "", name: "", vendor: "Vendor", brand: null, sku: "sku", specification: "Checked",
  category: "furniture", room: "Living", quantity: 1, unitLabel: "each", currency: "USD",
  unitPriceCents: 0, taxCents: 0, freightCents: 0, sourceUrl: null, returnPolicy: "Checked",
  returnable: true, restockingFeeBps: null, customMade: false, leadTimeDays: null, origin: "unchanged",
};

const lineAmounts = fc.record({
  category,
  quantity: fc.integer({ min: 1, max: 4 }),
  unitPriceCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 500_000 })),
  taxCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
  freightCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 20_000 })),
});
type Amounts = typeof lineAmounts extends fc.Arbitrary<infer T> ? T : never;
const total = (amounts: Amounts) => calculateLineTotals(amounts).totalCents;

const CONFIRMED: readonly OldItemHandling[] = ["not_ordered", "cancelled", "returned", "retained"];
const ALL_HANDLINGS: readonly OldItemHandling[] = [...CONFIRMED, "pending", "not_applicable"];

/** What happens to one V1 line in the change order. */
const baselineSpec = (handlings: readonly OldItemHandling[]) => fc.record({
  before: lineAmounts,
  action: fc.oneof(
    { arbitrary: fc.constant("none" as const), weight: 2 },
    { arbitrary: fc.constant("replace" as const), weight: 1 },
    { arbitrary: fc.constant("remove" as const), weight: 1 },
    { arbitrary: fc.constant("quantity" as const), weight: 1 },
  ),
  handling: fc.constantFrom(...handlings),
  costCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 200_000 })),
  after: lineAmounts,
});
type BaselineSpec = typeof baselineSpec extends (h: never) => fc.Arbitrary<infer T> ? T : never;

interface Group { itemId: string; side: Side; targetCents: number; handling?: OldItemHandling }

/** Builds a consistent frozen change order and the funding lines it should produce. */
function changeOrder(specs: BaselineSpec[], additions: Amounts[]): { order: FrozenChangeOrder; groups: Group[] } {
  const baselineLines: ApprovedQuoteLine[] = [];
  const lines: FinalQuoteLine[] = [];
  const changes: ReviewedChange[] = [];
  const groups: Group[] = [];
  const finalLine = (itemId: string, amounts: Amounts, origin: FinalQuoteLine["origin"]): FinalQuoteLine => ({ ...finalTemplate, itemId, name: itemId, ...amounts, origin });

  specs.forEach((spec, i) => {
    const itemId = `item-${i}`;
    const before: ApprovedQuoteLine = { ...approvedTemplate, itemId, name: itemId, ...spec.before };
    baselineLines.push(before);
    if (spec.action === "none") {
      lines.push(finalLine(itemId, spec.before, "unchanged"));
      groups.push({ itemId, side: "baseline", targetCents: total(spec.before) });
      return;
    }
    const changeKey = `change-${i}`;
    const amounts = spec.action === "quantity" ? { ...spec.before, quantity: spec.after.quantity, taxCents: spec.after.taxCents } : spec.after;
    const after = spec.action === "remove" ? null : finalLine(itemId, amounts, "changed");
    changes.push({
      key: changeKey, action: spec.action, itemId, before, after,
      oldItemHandling: spec.handling, oldItemCostCents: spec.costCents, oldItemNote: "Checked", priceEvidence: "Checked",
    });
    if (after) lines.push(after);
    if (spec.costCents > 0) {
      lines.push(finalLine(`old-cost-${DRAFT}-${changeKey}`, { category: "service", quantity: 1, unitPriceCents: spec.costCents, taxCents: 0, freightCents: 0 }, "old_item_cost"));
    }
    if (spec.action === "quantity") {
      groups.push({ itemId, side: "baseline", targetCents: total(amounts) + spec.costCents, handling: spec.handling });
    } else {
      // The old product keeps only its reviewed old-item cost; a replacement is funded on its own line.
      groups.push({ itemId, side: "baseline", targetCents: spec.costCents, handling: spec.handling });
      if (after) groups.push({ itemId, side: "proposed", targetCents: total(amounts) });
    }
  });
  additions.forEach((amounts, j) => {
    const itemId = `new-${j}`;
    const line = finalLine(itemId, amounts, "changed");
    lines.push(line);
    changes.push({
      key: `add-${j}`, action: "add", itemId: null, before: null, after: line,
      oldItemHandling: "not_applicable", oldItemCostCents: 0, oldItemNote: "", priceEvidence: "Checked",
    });
    groups.push({ itemId, side: "proposed", targetCents: total(amounts) });
  });

  const baselineTotals = calculateQuoteTotals(baselineLines);
  const totals = calculateQuoteTotals(lines);
  const order: FrozenChangeOrder = {
    id: "order-1", version: 2, issuedAt: "2026-10-20T10:10:00.000Z", reviewId: "review-1", reviewVersion: 1,
    revisionId: "revision-1", revisionContentHash: "revision-hash", contentHash: "full-hash",
    baselineFingerprint: "baseline", projectKey: "willow", basedOnQuoteId: "quote-1", basedOnVersion: 1,
    projectName: "Willow", clientName: "Client", designerName: "Designer", currency: "USD", isDemo: true,
    title: "Change order", sourceDraftId: DRAFT, sourceDraftRevision: 1,
    changes, lines, baselineLines, baselineTotals, totals,
    deltaTotalCents: totals.totalCents - baselineTotals.totalCents, terms: "Checked", reviewNotes: "",
    issues: [], constraints: [], sourceMessages: [], sources: [],
  };
  return { order, groups };
}

/** 1 to 6 V1 lines that are kept, replaced, removed or re-quantified, plus up to 2 new lines, with money on some of them. */
const changeCase = (handlings: readonly OldItemHandling[]): fc.Arbitrary<Case<FrozenChangeOrder>> => fc.record({
  specs: fc.array(baselineSpec(handlings), { minLength: 1, maxLength: 6 }),
  additions: fc.array(lineAmounts, { maxLength: 2 }),
}).map(({ specs, additions }) => changeOrder(specs, additions)).chain(({ order, groups }) =>
  fc.tuple(...groups.map((group) => fc.option(recordedMoney(group.targetCents), { nil: undefined, freq: 3 }))).map((moneys) => {
    const recorded: FundingLineFact[] = moneys.flatMap((money, i) => money ? [{ itemId: groups[i].itemId, side: groups[i].side, ...money }] : []);
    return {
      doc: order,
      facts: { status: recorded.length ? "recorded" : "no_records", checkedAt, lines: recorded },
      targets: new Map(groups.map((group) => [key(group.itemId, group.side), group.targetCents])),
      handlings: new Map(groups.flatMap((group) => group.handling ? [[key(group.itemId, group.side), group.handling] as const] : [])),
    };
  }));

// ---------------------------------------------------------------- the money rules

/** What the plan moves for one line, by action kind. */
function moved(plan: FundingPlan, line: FundingLine) {
  const mine = plan.actions.filter((action) => action.itemId === line.itemId && action.side === line.side);
  const sum = (kind: FundingPlan["actions"][number]["kind"]) => mine.filter((action) => action.kind === kind).reduce((total, action) => total + action.amountCents, 0);
  return { refund: sum("refund"), release: sum("release_authorization"), capture: sum("capture"), newHold: sum("new_authorization") };
}

const factFor = (c: Case<unknown>, itemId: string, side: Side) => c.facts.lines.find((fact) => fact.itemId === itemId && (fact.side ?? "baseline") === side);

/** Valid money must never be refused. */
function expectAccepted(plan: FundingPlan): FundingPlan {
  expect(plan.blockers).toEqual([]);
  expect(plan.status).not.toBe("blocked");
  return plan;
}

function expectRefused(plan: FundingPlan) {
  expect(plan.status).toBe("blocked");
  expect(plan.blockers.length).toBeGreaterThan(0);
  expect(plan.actions).toEqual([]);
  expect(plan.money).toEqual({ newAuthorizationCents: null, releaseCents: null, chargeCents: null, refundCents: null });
}

const rules: [name: string, check: (plan: FundingPlan, c: Case<unknown>) => void][] = [
  ["1. every line ends exactly at its approved target once the plan runs", (plan, c) => {
    expect(plan.lines.map((line) => key(line.itemId, line.side)).sort()).toEqual([...c.targets.keys()].sort());
    for (const action of plan.actions) {
      expect(Number.isSafeInteger(action.amountCents) && action.amountCents > 0).toBe(true);
      expect(plan.lines.some((line) => line.itemId === action.itemId && line.side === action.side)).toBe(true);
    }
    for (const line of plan.lines) {
      const cancelled = factFor(c, line.itemId, line.side)?.cancelled;
      expect(line.targetCents).toBe(cancelled ? 0 : c.targets.get(key(line.itemId, line.side)));
      const m = moved(plan, line);
      expect(line.capturedCents - line.refundedCents - m.refund + m.capture + m.newHold).toBe(line.targetCents);
    }
  }],
  ["2. never refunds more than was captured and not yet refunded", (plan) => {
    for (const line of plan.lines) expect(moved(plan, line).refund).toBeLessThanOrEqual(line.capturedCents - line.refundedCents);
  }],
  ["3. uses a hold at most once: what is released and captured from it never exceeds it", (plan) => {
    for (const line of plan.lines) {
      const m = moved(plan, line);
      expect(m.release).toBeLessThanOrEqual(line.heldCents);
      // A release closes the hold: the rest of it is captured, nothing beyond it.
      if (m.release > 0) expect(m.release + m.capture).toBe(line.heldCents);
      // A new hold is only asked for when the existing one is used up, never next to a release.
      if (m.newHold > 0) expect(m.release).toBe(0);
    }
  }],
  ["4. moves each line's money in one direction: a refunded line is never charged or held again", (plan) => {
    for (const line of plan.lines) {
      const m = moved(plan, line);
      if (m.refund > 0) expect({ capture: m.capture, newHold: m.newHold }).toEqual({ capture: 0, newHold: 0 });
    }
  }],
  ["5. never charges or holds a cancelled line, and releases all of its hold", (plan, c) => {
    for (const line of plan.lines) {
      if (!factFor(c, line.itemId, line.side)?.cancelled) continue;
      const m = moved(plan, line);
      expect(line.cancelledTargetCents).toBe(c.targets.get(key(line.itemId, line.side)));
      expect({ capture: m.capture, newHold: m.newHold, release: m.release }).toEqual({ capture: 0, newHold: 0, release: line.heldCents });
    }
  }],
  ["only furniture gets a new hold; services are charged instead", (plan) => {
    for (const line of plan.lines) if (line.category === "service") expect(moved(plan, line).newHold).toBe(0);
  }],
];

// ---------------------------------------------------------------- broken input

const factCorruptions = [
  "refund_above_capture", "negative_amount", "fractional_cents", "uncertain_result",
  "duplicate_record", "unknown_item", "records_without_status", "bad_check_time",
] as const;
type FactCorruption = (typeof factCorruptions)[number];
const isFactCorruption = (kind: string): kind is FactCorruption => (factCorruptions as readonly string[]).includes(kind);

/** Breaks one thing in otherwise valid money records. */
function corruptFacts(facts: FundingFacts, fallbackItemId: string, kind: FactCorruption): FundingFacts {
  const records = facts.lines.length ? facts.lines.map((fact) => ({ ...fact })) : [{ itemId: fallbackItemId, heldCents: 0, capturedCents: 0, refundedCents: 0 }];
  const first: FundingLineFact = records[0];
  let status: FundingFacts["status"] = "recorded";
  let time = checkedAt;
  switch (kind) {
    case "refund_above_capture": first.refundedCents = first.capturedCents + 1; break;
    case "negative_amount": first.heldCents = -1; break;
    case "fractional_cents": first.capturedCents += 0.5; break;
    case "uncertain_result": first.uncertainReason = "The PayPal capture is still pending."; break;
    case "duplicate_record": records.push({ ...first }); break;
    case "unknown_item": records.push({ itemId: "not-in-this-quote", heldCents: 100, capturedCents: 0, refundedCents: 0 }); break;
    case "records_without_status": status = "no_records"; break;
    case "bad_check_time": time = "not a date"; break;
  }
  return { status, checkedAt: time, lines: records };
}

// ---------------------------------------------------------------- the tests

describe("buildOpeningPlan properties (V1)", () => {
  const plan = (c: Case<OpeningFundingLine[]>) => buildOpeningPlan(opening, c.doc, c.facts);

  for (const [name, check] of rules) {
    it(name, () => fc.assert(fc.property(openingCase, (c) => check(expectAccepted(plan(c)), c)), RUNS));
  }

  it("6. refuses the whole plan when any record is uncertain or invalid", () => {
    fc.assert(fc.property(openingCase, fc.constantFrom(...factCorruptions, "bad_target" as const), (c, kind) => {
      expectRefused(isFactCorruption(kind)
        ? buildOpeningPlan(opening, c.doc, corruptFacts(c.facts, c.doc[0].itemId, kind))
        : buildOpeningPlan(opening, [{ ...c.doc[0], targetCents: -100 }, ...c.doc.slice(1)], c.facts));
    }), RUNS);
  });
});

describe("buildFundingPlan properties (V2 change order)", () => {
  const confirmed = changeCase(CONFIRMED);

  for (const [name, check] of rules) {
    it(name, () => fc.assert(fc.property(confirmed, (c) => check(expectAccepted(buildFundingPlan(c.doc, c.facts)), c)), RUNS));
  }

  it("6. refuses the whole plan when any record is uncertain or invalid, or the document totals were altered", () => {
    fc.assert(fc.property(confirmed, fc.constantFrom(...factCorruptions, "tampered_delta" as const, "tampered_totals" as const), (c, kind) => {
      const order = c.doc;
      if (isFactCorruption(kind)) expectRefused(buildFundingPlan(order, corruptFacts(c.facts, order.baselineLines[0].itemId, kind)));
      else if (kind === "tampered_delta") expectRefused(buildFundingPlan({ ...order, deltaTotalCents: order.deltaTotalCents + 1 }, c.facts));
      else expectRefused(buildFundingPlan({ ...order, totals: { ...order.totals, totalCents: order.totals.totalCents + 1 } }, c.facts));
    }), RUNS);
  });

  it("7. never refunds a returned or cancelled old item before the vendor credit is verified", () => {
    fc.assert(fc.property(confirmed, (c) => {
      const plan = expectAccepted(buildFundingPlan(c.doc, c.facts));
      for (const action of plan.actions) {
        if (action.kind !== "refund") continue;
        const handling = c.handlings.get(key(action.itemId, action.side));
        const waitsForVendor = (handling === "returned" || handling === "cancelled") && !factFor(c, action.itemId, action.side)?.vendorCreditConfirmed;
        expect(action.timing).toBe(waitsForVendor ? "after_vendor_credit" : "on_payment_execution");
      }
    }), RUNS);
  });

  it("8. refuses to refund an old item until its return or cancellation is decided", () => {
    fc.assert(fc.property(changeCase(ALL_HANDLINGS), (c) => {
      const plan = buildFundingPlan(c.doc, c.facts);
      const undecidedRefund = plan.lines.some((line) => {
        const handling = c.handlings.get(key(line.itemId, line.side));
        return (handling === "pending" || handling === "not_applicable") && line.capturedCents - line.refundedCents > line.targetCents;
      });
      if (!undecidedRefund) {
        expectAccepted(plan);
        return;
      }
      expectRefused(plan);
      expect(plan.blockers.join(" ")).toContain("confirmed old-item handling decision");
    }), RUNS);
  });
});
