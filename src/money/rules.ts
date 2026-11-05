/**
 * Per-line money rules: given where one line's money stands and how the line
 * changes, decide the PayPal actions. A swap is modelled as "remove" plus
 * "add"; there is no separate swap rule.
 *
 *                     | remove                         | price down             | price up
 * --------------------+--------------------------------+------------------------+------------------------------------------
 * quoted              | nothing                        | nothing                | nothing
 * held (authorized)   | void the authorization         | capture less           | over-capture within allowance, otherwise
 *                     |                                |                        | hold the difference (vault) or ask client
 * captured, no PO     | full refund now                | refund the difference  | vault charge, otherwise ask client
 * captured, PO placed | vendor return; refund minus    | refund the difference  | vault charge, otherwise ask client
 *                     | restocking fee after the       |                        |
 *                     | vendor credit lands            |                        |
 * new line            | furniture: new hold; service: charge on approval
 */
import { assertCents, overCaptureAllowance, restockingFee } from "./limits";
import { DEFAULT_REFUND_PROMISE_BUSINESS_DAYS } from "./refundPromise";
import type { Cents, ExistingLine, LineChange, MoneyAction, PlanContext } from "./types";

export interface LineOutcome {
  actions: MoneyAction[];
  /** What this line contributes to the approved budget after the change. */
  budgetAfterCents: Cents;
}

type ExistingChange = Exclude<LineChange, { type: "add" }>;
type AddChange = Extract<LineChange, { type: "add" }>;

export function applyLineChange(
  line: ExistingLine,
  change: ExistingChange,
  ctx: PlanContext,
): LineOutcome {
  if (change.lineId !== line.id) {
    throw new Error(`change for ${change.lineId} applied to line ${line.id}`);
  }
  return change.type === "remove" ? removeLine(line, change, ctx) : repriceLine(line, change, ctx);
}

function removeLine(
  line: ExistingLine,
  change: Extract<LineChange, { type: "remove" }>,
  ctx: PlanContext,
): LineOutcome {
  const p = line.payment;
  switch (p.kind) {
    case "quoted":
      return {
        actions: [{ kind: "none", lineId: line.id, reason: "No money has moved for this line." }],
        budgetAfterCents: 0,
      };

    case "held":
      return {
        actions: [
          {
            kind: "void_authorization",
            lineId: line.id,
            releaseCents: p.authorizedCents,
            reason: "Not captured yet, so the hold is voided. This is a release, not a refund.",
          },
        ],
        budgetAfterCents: 0,
      };

    case "captured": {
      if (!p.poPlaced) {
        return {
          actions: [
            {
              kind: "refund",
              lineId: line.id,
              amountCents: p.capturedCents,
              retainedCents: 0,
              timing: "now",
              reason: "Captured but not yet ordered from the vendor, so the full amount is refunded.",
            },
          ],
          budgetAfterCents: 0,
        };
      }

      if (change.nonReturnable) {
        return {
          actions: [
            {
              kind: "none",
              lineId: line.id,
              reason: "Custom or non-returnable item: nothing can be refunded. The client must see this before approving.",
            },
          ],
          budgetAfterCents: p.capturedCents,
        };
      }

      const fee = restockingFee(p.capturedCents, change.restockingFeeBps ?? 0);
      const days = ctx.refundPromiseBusinessDays ?? DEFAULT_REFUND_PROMISE_BUSINESS_DAYS;
      return {
        actions: [
          {
            kind: "vendor_return",
            lineId: line.id,
            restockingFeeCents: fee,
            reason: "Already ordered: the studio returns it to the vendor.",
          },
          {
            kind: "refund",
            lineId: line.id,
            amountCents: p.capturedCents - fee,
            retainedCents: fee,
            timing: "after_vendor_credit",
            promiseBusinessDays: days,
            reason: `Refund the captured amount minus the restocking fee, within ${days} business days after the vendor credit lands.`,
          },
        ],
        budgetAfterCents: fee,
      };
    }
  }
}

function repriceLine(
  line: ExistingLine,
  change: Extract<LineChange, { type: "reprice" }>,
  ctx: PlanContext,
): LineOutcome {
  assertCents(change.newPriceCents, "newPriceCents");
  const newPrice = change.newPriceCents;
  const p = line.payment;
  const unchanged = (reason: string): LineOutcome => ({
    actions: [{ kind: "none", lineId: line.id, reason }],
    budgetAfterCents: newPrice,
  });

  switch (p.kind) {
    case "quoted":
      return unchanged("No money has moved; the new price simply replaces the quote.");

    case "held": {
      const authorized = p.authorizedCents;
      if (newPrice === authorized) return unchanged("Price matches the hold.");
      if (newPrice < authorized) {
        return {
          actions: [
            {
              kind: "capture_less",
              lineId: line.id,
              captureCents: newPrice,
              releaseCents: authorized - newPrice,
              reason: "Capture only the new price when the vendor confirms; the rest of the hold is released. No new checkout needed.",
            },
          ],
          budgetAfterCents: newPrice,
        };
      }
      const extra = newPrice - authorized;
      const allowance = overCaptureAllowance(authorized);
      if (extra <= allowance) {
        return {
          actions: [
            {
              kind: "over_capture",
              lineId: line.id,
              captureCents: newPrice,
              extraCents: extra,
              reason: `Within PayPal's over-capture allowance (${allowance} cents on this hold), so the new price is captured directly once the client approves it.`,
            },
          ],
          budgetAfterCents: newPrice,
        };
      }
      return {
        actions: [
          ctx.hasVault
            ? {
                kind: "new_authorization",
                lineId: line.id,
                amountCents: extra,
                via: "vault",
                reason: `The increase exceeds the over-capture allowance (${allowance} cents), so the difference is held separately against the saved PayPal.`,
              }
            : {
                kind: "ask_client_to_pay",
                lineId: line.id,
                amountCents: extra,
                reason: `The increase exceeds the over-capture allowance (${allowance} cents) and no PayPal is saved, so the client pays the difference through checkout.`,
              },
        ],
        budgetAfterCents: newPrice,
      };
    }

    case "captured": {
      const captured = p.capturedCents;
      if (newPrice === captured) return unchanged("Price matches what was captured.");
      if (newPrice < captured) {
        return {
          actions: [
            {
              kind: "refund",
              lineId: line.id,
              amountCents: captured - newPrice,
              retainedCents: 0,
              timing: "now",
              reason: "Price went down after capture, so the difference is refunded.",
            },
          ],
          budgetAfterCents: newPrice,
        };
      }
      const extra = newPrice - captured;
      return {
        actions: [
          ctx.hasVault
            ? {
                kind: "vault_charge",
                lineId: line.id,
                amountCents: extra,
                reason: "Price went up after capture; the approved difference is charged to the saved PayPal.",
              }
            : {
                kind: "ask_client_to_pay",
                lineId: line.id,
                amountCents: extra,
                reason: "Price went up after capture and no PayPal is saved, so the client pays the difference through checkout.",
              },
        ],
        budgetAfterCents: newPrice,
      };
    }
  }
}

export function addLine(change: AddChange, ctx: PlanContext): LineOutcome {
  assertCents(change.priceCents, "priceCents");
  const via = ctx.hasVault ? "vault" : "checkout";
  const action: MoneyAction =
    change.category === "furniture"
      ? {
          kind: "new_authorization",
          lineId: change.lineId,
          amountCents: change.priceCents,
          via,
          reason: "New products are held, then captured once the vendor confirms stock and price.",
        }
      : {
          kind: "immediate_capture",
          lineId: change.lineId,
          amountCents: change.priceCents,
          via,
          reason: "Services do not wait on a vendor, so they are charged on approval.",
        };
  return { actions: [action], budgetAfterCents: change.priceCents };
}
