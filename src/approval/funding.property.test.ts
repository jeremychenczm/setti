/**
 * Property tests for the funding planner: instead of hand-picked examples,
 * fast-check generates random approved lines and random money already held,
 * captured and refunded, and every plan must keep the same money rules.
 * A failure prints the seed and path; pass them to `fc.assert` to replay it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildOpeningPlan, type FundingFacts, type FundingLine, type FundingLineFact, type FundingPlan, type OpeningFundingLine } from "./funding";

const RUNS = { numRuns: 1000 };
const MAX_CENTS = 2_000_000; // $20,000
const opening = { id: "v1-revision", contentHash: "a".repeat(64) };
const checkedAt = "2026-10-20T11:00:00.000Z";

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
}));

const lineSpec = fc.record({
  category: fc.constantFrom("furniture" as const, "service" as const),
  targetCents: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: MAX_CENTS })),
}).chain((line) => fc.record({
  line: fc.constant(line),
  money: fc.option(recordedMoney(line.targetCents), { nil: undefined, freq: 5 }),
}));

interface OpeningCase { lines: OpeningFundingLine[]; facts: FundingFacts }

/** A V1 signed line by line: 1 to 8 lines, some with no money recorded yet. */
const openingCase: fc.Arbitrary<OpeningCase> = fc.array(lineSpec, { minLength: 1, maxLength: 8 }).map((specs) => {
  const lines = specs.map(({ line }, i) => ({ itemId: `item-${i}`, label: `Item ${i}`, ...line }));
  const recorded: FundingLineFact[] = specs.flatMap(({ money }, i) => money ? [{ itemId: `item-${i}`, ...money }] : []);
  return { lines, facts: { status: recorded.length ? "recorded" : "no_records", checkedAt, lines: recorded } };
});

/** What the plan moves for one line, by action kind. */
function moved(plan: FundingPlan, line: FundingLine) {
  const mine = plan.actions.filter((action) => action.itemId === line.itemId && action.side === line.side);
  const total = (kind: FundingPlan["actions"][number]["kind"]) => mine.filter((action) => action.kind === kind).reduce((sum, action) => sum + action.amountCents, 0);
  return { refund: total("refund"), release: total("release_authorization"), capture: total("capture"), newHold: total("new_authorization") };
}

/** Builds the plan for a valid case and checks it was not blocked: valid money must never be refused. */
function planFor({ lines, facts }: OpeningCase): FundingPlan {
  const plan = buildOpeningPlan(opening, lines, facts);
  expect(plan.blockers).toEqual([]);
  expect(plan.status).not.toBe("blocked");
  return plan;
}

describe("buildOpeningPlan properties", () => {
  it("1. every line ends exactly at its approved target once the plan runs", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      for (const action of plan.actions) {
        expect(Number.isSafeInteger(action.amountCents) && action.amountCents > 0).toBe(true);
        expect(plan.lines.some((line) => line.itemId === action.itemId && line.side === action.side)).toBe(true);
      }
      for (const line of plan.lines) {
        const m = moved(plan, line);
        expect(line.capturedCents - line.refundedCents - m.refund + m.capture + m.newHold).toBe(line.targetCents);
      }
    }), RUNS);
  });

  it("2. never refunds more than was captured and not yet refunded", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      for (const line of plan.lines) expect(moved(plan, line).refund).toBeLessThanOrEqual(line.capturedCents - line.refundedCents);
    }), RUNS);
  });

  it("3. uses a hold at most once: what is released and captured from it never exceeds it", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      for (const line of plan.lines) {
        const m = moved(plan, line);
        expect(m.release).toBeLessThanOrEqual(line.heldCents);
        // A release closes the hold: the rest of it is captured, nothing beyond it.
        if (m.release > 0) expect(m.release + m.capture).toBe(line.heldCents);
        // A new hold is only asked for when the existing one is used up, never next to a release.
        if (m.newHold > 0) expect(m.release).toBe(0);
      }
    }), RUNS);
  });

  it("4. moves each line's money in one direction: a refunded line is never charged or held again", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      for (const line of plan.lines) {
        const m = moved(plan, line);
        if (m.refund > 0) expect({ capture: m.capture, newHold: m.newHold }).toEqual({ capture: 0, newHold: 0 });
      }
    }), RUNS);
  });

  it("5. never charges or holds a cancelled line, and releases all of its hold", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      const targets = new Map(input.lines.map((line) => [line.itemId, line.targetCents]));
      const cancelled = new Set(input.facts.lines.filter((fact) => fact.cancelled).map((fact) => fact.itemId));
      for (const line of plan.lines) {
        if (!cancelled.has(line.itemId)) {
          expect(line.targetCents).toBe(targets.get(line.itemId));
          continue;
        }
        const m = moved(plan, line);
        expect(line).toMatchObject({ targetCents: 0, cancelledTargetCents: targets.get(line.itemId) });
        expect({ capture: m.capture, newHold: m.newHold, release: m.release }).toEqual({ capture: 0, newHold: 0, release: line.heldCents });
      }
    }), RUNS);
  });

  it("only furniture gets a new hold; services are charged instead", () => {
    fc.assert(fc.property(openingCase, (input) => {
      const plan = planFor(input);
      for (const line of plan.lines) if (line.category === "service") expect(moved(plan, line).newHold).toBe(0);
    }), RUNS);
  });

  const corruptions = [
    "refund_above_capture", "negative_amount", "fractional_cents", "uncertain_result",
    "duplicate_record", "unknown_item", "records_without_status", "bad_check_time", "bad_target",
  ] as const;

  /** Breaks one thing in an otherwise valid case. */
  function corrupt({ lines, facts }: OpeningCase, kind: (typeof corruptions)[number]): OpeningCase {
    const records = facts.lines.length ? facts.lines.map((fact) => ({ ...fact })) : [{ itemId: lines[0].itemId, heldCents: 0, capturedCents: 0, refundedCents: 0 }];
    const first = records[0];
    let status: FundingFacts["status"] = "recorded";
    let time = checkedAt;
    let broken = lines;
    switch (kind) {
      case "refund_above_capture": first.refundedCents = first.capturedCents + 1; break;
      case "negative_amount": first.heldCents = -1; break;
      case "fractional_cents": first.capturedCents += 0.5; break;
      case "uncertain_result": first.uncertainReason = "The PayPal capture is still pending."; break;
      case "duplicate_record": records.push({ ...first }); break;
      case "unknown_item": records.push({ itemId: "not-in-this-quote", heldCents: 100, capturedCents: 0, refundedCents: 0 }); break;
      case "records_without_status": status = "no_records"; break;
      case "bad_check_time": time = "not a date"; break;
      case "bad_target": broken = [{ ...lines[0], targetCents: -100 }, ...lines.slice(1)]; break;
    }
    return { lines: broken, facts: { status, checkedAt: time, lines: records } };
  }

  it("6. refuses the whole plan when any record is uncertain or invalid", () => {
    fc.assert(fc.property(openingCase, fc.constantFrom(...corruptions), (input, kind) => {
      const { lines, facts } = corrupt(input, kind);
      const plan = buildOpeningPlan(opening, lines, facts);
      expect(plan.status).toBe("blocked");
      expect(plan.blockers.length).toBeGreaterThan(0);
      expect(plan.actions).toEqual([]);
      expect(plan.money).toEqual({ newAuthorizationCents: null, releaseCents: null, chargeCents: null, refundCents: null });
    }), RUNS);
  });
});
