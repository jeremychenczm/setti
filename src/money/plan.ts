/**
 * Builds the full money plan for one change revision: the budget delta and
 * the list of money actions, reported separately because "the budget went
 * up by $210" is not the same as "pay $210 now".
 */
import { addLine, applyLineChange } from "./rules";
import type { ChangePlan, ExistingLine, LineChange, MoneyAction, PlanContext } from "./types";

export function planChange(
  lines: ExistingLine[],
  changes: LineChange[],
  ctx: PlanContext,
): ChangePlan {
  const byId = new Map(lines.map((l) => [l.id, l]));
  if (byId.size !== lines.length) throw new Error("duplicate line ids in the approved revision");

  const changeFor = new Map<string, Exclude<LineChange, { type: "add" }>>();
  const additions: Extract<LineChange, { type: "add" }>[] = [];
  for (const c of changes) {
    if (c.type === "add") {
      if (byId.has(c.lineId) || additions.some((a) => a.lineId === c.lineId)) {
        throw new Error(`added line id ${c.lineId} is already in use`);
      }
      additions.push(c);
      continue;
    }
    if (!byId.has(c.lineId)) throw new Error(`unknown line ${c.lineId}`);
    if (changeFor.has(c.lineId)) throw new Error(`more than one change for line ${c.lineId}`);
    changeFor.set(c.lineId, c);
  }

  const actions: MoneyAction[] = [];
  let budgetBeforeCents = 0;
  let budgetAfterCents = 0;

  for (const line of lines) {
    budgetBeforeCents += line.priceCents;
    const change = changeFor.get(line.id);
    if (!change) {
      budgetAfterCents += line.priceCents;
      continue;
    }
    const outcome = applyLineChange(line, change, ctx);
    actions.push(...outcome.actions);
    budgetAfterCents += outcome.budgetAfterCents;
  }

  for (const add of additions) {
    const outcome = addLine(add, ctx);
    actions.push(...outcome.actions);
    budgetAfterCents += outcome.budgetAfterCents;
  }

  return {
    budgetBeforeCents,
    budgetAfterCents,
    budgetDeltaCents: budgetAfterCents - budgetBeforeCents,
    actions,
    money: summarize(actions),
  };
}

function summarize(actions: MoneyAction[]): ChangePlan["money"] {
  const money = { releasedCents: 0, refundCents: 0, newHoldCents: 0, newChargeCents: 0 };
  for (const a of actions) {
    switch (a.kind) {
      case "void_authorization":
        money.releasedCents += a.releaseCents;
        break;
      case "capture_less":
        money.releasedCents += a.releaseCents;
        break;
      case "refund":
        money.refundCents += a.amountCents;
        break;
      case "new_authorization":
        money.newHoldCents += a.amountCents;
        break;
      case "over_capture":
        money.newChargeCents += a.extraCents;
        break;
      case "immediate_capture":
      case "vault_charge":
      case "ask_client_to_pay":
        money.newChargeCents += a.amountCents;
        break;
      case "none":
      case "vendor_return":
        break;
    }
  }
  return money;
}
