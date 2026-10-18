import { describe, expect, it } from "vitest";
import { overCaptureAllowance, restockingFee } from "./limits";
import { planChange } from "./plan";
import { addLine, applyLineChange } from "./rules";
import type { ExistingLine, PaymentState } from "./types";

const $ = (dollars: number) => Math.round(dollars * 100);

function line(payment: PaymentState, priceCents: number, id = "item"): ExistingLine {
  return { id, label: id, category: "furniture", priceCents, payment };
}

const held = (dollars: number) => line({ kind: "held", authorizedCents: $(dollars) }, $(dollars));
const vault = { hasVault: true };
const noVault = { hasVault: false };

describe("over-capture allowance (15% or $75, whichever is less)", () => {
  it("uses 15% below $500", () => {
    expect(overCaptureAllowance($(400))).toBe($(60));
    expect(overCaptureAllowance($(100))).toBe($(15));
  });

  it("caps at $75 from $500 up", () => {
    expect(overCaptureAllowance($(500))).toBe($(75));
    expect(overCaptureAllowance($(1100))).toBe($(75));
  });

  it("rounds down", () => {
    expect(overCaptureAllowance(333)).toBe(49);
  });

  it("rejects fractional cents", () => {
    expect(() => overCaptureAllowance(10.5)).toThrow(RangeError);
  });
});

describe("held line, price goes up", () => {
  it("over-captures when the increase equals the allowance exactly", () => {
    const [a] = applyLineChange(held(400), { type: "reprice", lineId: "item", newPriceCents: $(460) }, vault).actions;
    expect(a).toMatchObject({ kind: "over_capture", captureCents: $(460), extraCents: $(60) });
  });

  it("holds the difference against the vault one cent past the allowance", () => {
    const [a] = applyLineChange(held(400), { type: "reprice", lineId: "item", newPriceCents: $(460) + 1 }, vault).actions;
    expect(a).toMatchObject({ kind: "new_authorization", amountCents: $(60) + 1, via: "vault" });
  });

  it("asks the client to pay when past the allowance and nothing is saved", () => {
    const [a] = applyLineChange(held(400), { type: "reprice", lineId: "item", newPriceCents: $(500) }, noVault).actions;
    expect(a).toMatchObject({ kind: "ask_client_to_pay", amountCents: $(100) });
  });

  it("limits a $1,100 item to $75 extra", () => {
    const ok = applyLineChange(held(1100), { type: "reprice", lineId: "item", newPriceCents: $(1175) }, vault);
    expect(ok.actions[0]).toMatchObject({ kind: "over_capture", extraCents: $(75) });
    const over = applyLineChange(held(1100), { type: "reprice", lineId: "item", newPriceCents: $(1200) }, vault);
    expect(over.actions[0]).toMatchObject({ kind: "new_authorization", amountCents: $(100) });
  });
});

describe("held line, other changes", () => {
  it("captures less when the price goes down", () => {
    const out = applyLineChange(held(800), { type: "reprice", lineId: "item", newPriceCents: $(700) }, vault);
    expect(out.actions[0]).toMatchObject({ kind: "capture_less", captureCents: $(700), releaseCents: $(100) });
    expect(out.budgetAfterCents).toBe($(700));
  });

  it("voids the hold when removed", () => {
    const out = applyLineChange(held(800), { type: "remove", lineId: "item" }, vault);
    expect(out.actions).toEqual([expect.objectContaining({ kind: "void_authorization", releaseCents: $(800) })]);
    expect(out.budgetAfterCents).toBe(0);
  });
});

describe("captured line", () => {
  const capturedNoPo = line({ kind: "captured", capturedCents: $(500), poPlaced: false }, $(500));
  const capturedPo = line({ kind: "captured", capturedCents: $(500), poPlaced: true }, $(500));

  it("refunds in full right away if nothing was ordered yet", () => {
    const out = applyLineChange(capturedNoPo, { type: "remove", lineId: "item", restockingFeeBps: 2000 }, vault);
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: "refund", amountCents: $(500), retainedCents: 0, timing: "now" }),
    ]);
  });

  it("keeps the full amount for a non-returnable item", () => {
    const out = applyLineChange(capturedPo, { type: "remove", lineId: "item", nonReturnable: true }, vault);
    expect(out.actions[0]).toMatchObject({ kind: "none" });
    expect(out.budgetAfterCents).toBe($(500));
  });

  it("uses the configured refund promise window", () => {
    const out = applyLineChange(
      capturedPo,
      { type: "remove", lineId: "item", restockingFeeBps: 1500 },
      { hasVault: true, refundPromiseBusinessDays: 10 },
    );
    expect(out.actions).toContainEqual(
      expect.objectContaining({ kind: "refund", amountCents: $(425), retainedCents: $(75), promiseBusinessDays: 10 }),
    );
  });

  it("refunds the difference when the price goes down", () => {
    const out = applyLineChange(capturedPo, { type: "reprice", lineId: "item", newPriceCents: $(450) }, vault);
    expect(out.actions[0]).toMatchObject({ kind: "refund", amountCents: $(50), timing: "now" });
  });

  it("asks the client to pay an increase when nothing is saved", () => {
    const out = applyLineChange(capturedPo, { type: "reprice", lineId: "item", newPriceCents: $(550) }, noVault);
    expect(out.actions[0]).toMatchObject({ kind: "ask_client_to_pay", amountCents: $(50) });
  });
});

describe("quoted line and new lines", () => {
  const quoted = line({ kind: "quoted" }, $(300));

  it("moves no money for a quoted line", () => {
    expect(applyLineChange(quoted, { type: "remove", lineId: "item" }, vault).actions[0].kind).toBe("none");
    const repriced = applyLineChange(quoted, { type: "reprice", lineId: "item", newPriceCents: $(350) }, vault);
    expect(repriced.actions[0].kind).toBe("none");
    expect(repriced.budgetAfterCents).toBe($(350));
  });

  it("falls back to checkout for new lines when nothing is saved", () => {
    const out = addLine({ type: "add", lineId: "lamp", label: "Lamp", category: "furniture", priceCents: $(200) }, noVault);
    expect(out.actions[0]).toMatchObject({ kind: "new_authorization", via: "checkout", amountCents: $(200) });
  });
});

describe("input validation", () => {
  const lines = [held(800)];

  it("rejects changes for unknown lines", () => {
    expect(() => planChange(lines, [{ type: "remove", lineId: "nope" }], vault)).toThrow(/unknown line/);
  });

  it("rejects two changes to the same line", () => {
    expect(() =>
      planChange(
        lines,
        [
          { type: "remove", lineId: "item" },
          { type: "reprice", lineId: "item", newPriceCents: 1 },
        ],
        vault,
      ),
    ).toThrow(/more than one change/);
  });

  it("rejects an added line that reuses an existing id", () => {
    expect(() =>
      planChange(lines, [{ type: "add", lineId: "item", label: "x", category: "service", priceCents: 1 }], vault),
    ).toThrow(/already in use/);
  });

  it("rejects non-integer cents and bad fee rates", () => {
    expect(() => applyLineChange(held(800), { type: "reprice", lineId: "item", newPriceCents: 1.5 }, vault)).toThrow(
      RangeError,
    );
    expect(() => restockingFee($(100), 12_000)).toThrow(RangeError);
  });
});
