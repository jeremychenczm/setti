import { and, desc, eq } from "drizzle-orm";
import { approvedQuoteFromOrder } from "../approval/baseline";
import { changeOrderDecisions } from "../approval/schema";
import { caseQuote } from "../chat/cases";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import type { Db } from "../db/client";
import { revisions } from "../db/schema";
import { changeOrders } from "../pricing/schema";
import { calculateQuoteTotals } from "../quotes/totals";
import type { PaymentLineView, PaymentsWorkspace } from "../payments/types";
import { paymentsWorkspace } from "../payments/workspace";
import type { FrozenChangeOrder } from "../pricing/types";
import type { MoneyContext, MoneyFact, MoneySource } from "./money-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const signed = (cents: number) => `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;

export class MoneyContextError extends Error {
  constructor(readonly code: "INVALID_MONEY_SCOPE" | "MONEY_EVIDENCE_UNAVAILABLE" | "MONEY_CONTEXT_LIMIT", message: string) {
    super(message);
    this.name = "MoneyContextError";
  }
}

/** No model, provider call, write, or case creation occurs while reading evidence. */
export async function readCaseMoneyContext(db: Db, sessionId: string, key: CaseKey): Promise<MoneyContext> {
  if (!UUID.test(sessionId) || !["willow", "maple"].includes(key)) {
    throw new MoneyContextError("INVALID_MONEY_SCOPE", "Money evidence requires the owning project session.");
  }
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: chatCases.id }).from(chatCases)
      .where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key)));
    if (!owned) throw new MoneyContextError("INVALID_MONEY_SCOPE", "Money evidence requires the owning project session.");
    const [approved] = await tx.select({ document: changeOrders.document, decision: changeOrderDecisions })
      .from(changeOrders)
      .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
      .innerJoin(changeOrderDecisions, and(eq(changeOrderDecisions.orderId, changeOrders.id), eq(changeOrderDecisions.revisionId, revisions.id)))
      .where(and(eq(changeOrders.caseId, owned.id), eq(changeOrderDecisions.decision, "approved")))
      .orderBy(desc(revisions.number)).limit(1);
    const now = new Date();
    if (!approved) {
      const quote = caseQuote(key);
      const source: MoneySource = { id: "quote", kind: "quote", label: `${quote.projectName} · V${quote.version} demo quote`, href: `/quotes/${key}`, recordedAt: quote.approvedAt };
      return bounded({
        projectKey: key, quoteId: quote.id, version: quote.version, checkedAt: now.toISOString(), providerRecordedAt: null, mode: "recorded_sandbox",
        sources: [source], mandatoryFactIds: ["no-payment-records"], facts: [
          fact("quote", `The initial demo-approved V${quote.version} quote totals ${usd(calculateQuoteTotals(quote.lines).totalCents)}. A quote approval is not a payment receipt.`, `初始演示确认报价 V${quote.version} 总额为 ${usd(calculateQuoteTotals(quote.lines).totalCents)}。报价确认不代表已付款。`, [source.id]),
          fact("no-payment-records", "No client-confirmed change order with payment evidence was found in this case. Payment, authorization and refund amounts are not established by the quote or by chat; do not assume they are zero or paid.", "本项目尚无已确认变更单及其支付依据。不能根据报价或聊天认定已付款、已授权或已退款，也不能把缺少记录当作实际金额为零。", [source.id]),
        ],
      });
    }
    const { document: order, decision } = approved;
    if (decision.sessionId !== sessionId || decision.contentHash !== order.contentHash || decision.revisionContentHash !== order.revisionContentHash) {
      throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The approved version and its decision could not be verified.");
    }
    const quote = approvedQuoteFromOrder(order, decision);
    const workspace = await paymentsWorkspace(tx, sessionId, order.id, now);
    if (!workspace || !workspace.current || !workspace.canAct) {
      throw new MoneyContextError("MONEY_EVIDENCE_UNAVAILABLE", "The current approved payment evidence is unavailable.");
    }
    return bounded(contextFromWorkspace(key, quote.id, order, decision.decidedAt.toISOString(), workspace, now));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function fact(id: string, en: string, zh: string, sourceIds: string[]): MoneyFact {
  return { id, text: { en, zh }, sourceIds: [...new Set(sourceIds)] };
}

function bounded(context: MoneyContext): MoneyContext {
  if (context.facts.length > 160 || context.sources.length > 500 || JSON.stringify(context).length > 100_000) {
    throw new MoneyContextError("MONEY_CONTEXT_LIMIT", "This case has more money evidence than this answer can safely include. No evidence was silently omitted.");
  }
  return context;
}

function contextFromWorkspace(key: CaseKey, quoteId: string, order: FrozenChangeOrder, approvedAt: string, workspace: PaymentsWorkspace, now: Date): MoneyContext {
  const href = `/change-orders/${order.id}`;
  const sources: MoneySource[] = [
    { id: "quote", kind: "quote", label: `Client-confirmed V${order.version} quote`, href, recordedAt: order.issuedAt },
    { id: "approval", kind: "approval", label: `Client confirmation · V${order.version}`, href, recordedAt: approvedAt },
  ];
  const mandatoryFactIds = ["record-freshness"];
  const facts: MoneyFact[] = [
    fact("budget", `The client-confirmed V${order.version} quote is ${usd(order.totals.totalCents)}, compared with ${usd(order.baselineTotals.totalCents)} in V${order.basedOnVersion}; the budget change is ${signed(order.deltaTotalCents)}. This difference is not an amount already charged or a checkout amount.`, `客户确认的 V${order.version} 报价为 ${usd(order.totals.totalCents)}，前一报价 V${order.basedOnVersion} 为 ${usd(order.baselineTotals.totalCents)}，预算变化 ${signed(order.deltaTotalCents)}。预算差额不等于已扣款金额，也不等于本次支付授权金额。`, ["quote", "approval"]),
    fact("approval", `The demo client confirmed this frozen V${order.version} on ${approvedAt}. Scope approval and PayPal buyer authorization are separate; the AI cannot approve or move money.`, `演示业主于 ${approvedAt} 确认冻结版本 V${order.version}。报价批准与 PayPal 买家授权是不同步骤，AI 不能批准或执行资金操作。`, ["approval"]),
  ];
  const lineSources = new Map<string, string[]>();
  const providerTimes: string[] = [];
  const relevant = new Map(workspace.lines.filter((line) => line.businessItemId).map((line) => [line.businessItemId!, line]));
  for (const operation of workspace.operations) {
    for (const call of operation.calls) if (call.httpStatus !== null) providerTimes.push(call.createdAt);
    if (operation.status !== "pending" && operation.status !== "unknown") continue;
    const line = operation.businessItemId ? relevant.get(operation.businessItemId) : undefined;
    const id = `operation:${operation.id}`;
    sources.push({ id, kind: "payment", label: `${operation.kind} · ${operation.status} · ${operation.paypalResourceId ?? operation.paypalOrderId ?? operation.id}`, href: `${href}${line ? lineAnchor(line) : "#payments"}`, recordedAt: operation.updatedAt });
    facts.push(fact(id, `${operation.itemLabel ?? "An item"} has a ${operation.kind} operation for ${usd(operation.amountCents)} whose outcome is ${operation.status}. Check the existing operation; do not assume completion or start a replacement payment.`, `${operation.itemLabel ?? "某物品"} 的 ${operation.kind} 操作金额为 ${usd(operation.amountCents)}，结果为 ${operation.status}。应先核对已有操作，不能认定成功或直接重新付款。`, [id]));
    mandatoryFactIds.push(id);
  }
  for (const line of workspace.lines) {
    const refs = addLineSources(line, href, sources);
    lineSources.set(`${line.side}:${line.itemId}`, refs);
    const net = line.capturedCents - line.refundedCents;
    const newPurchase = line.side === "proposed" && ["replace", "add"].includes(line.change ?? "");
    facts.push(fact(`item:${line.side}:${line.itemId}`, `${line.label} (${line.side}): this version's target is ${usd(line.targetCents)}; currently held ${usd(line.heldCents)}, completed captures ${usd(line.capturedCents)}, completed refunds ${usd(line.refundedCents)}, released authorization ${usd(line.releasedCents)}, net captured ${usd(net)}. A released authorization is not a refund of captured money.${newPurchase ? " This new purchase has its own authorization; another item's released hold or refund does not pay for this authorization." : ""}`, `${line.label}（${line.side === "baseline" ? "原物品" : "新物品"}）：本版本目标金额 ${usd(line.targetCents)}；当前授权余额 ${usd(line.heldCents)}，已完成扣款 ${usd(line.capturedCents)}，已完成退款 ${usd(line.refundedCents)}，已释放授权 ${usd(line.releasedCents)}，净扣款 ${usd(net)}。释放授权不是退回已扣款。${newPurchase ? "这是独立的新采购，授权针对本物品建立；其他物品释放的授权或另行退款不能抵扣本物品的授权金额。" : ""}`, refs));
    addNextFact(line, workspace, refs, facts);
    if (line.captures.some((capture) => capture.status === "pending") || line.refunds.some((refund) => refund.status === "pending")) {
      mandatoryFactIds.push(`next:${line.side}:${line.itemId}`);
    }
    const change = line.side === "baseline" ? order.changes.find((entry) => entry.itemId === line.itemId) : undefined;
    if (change) {
      facts.push(fact(`terms:${line.side}:${line.itemId}`, `${line.label}: the client-confirmed old-item handling is ${change.oldItemHandling}; the retained old-item cost is ${usd(change.oldItemCostCents)}. This amount is already included in the confirmed target and must not be deducted a second time.`, `${line.label}：客户确认的旧物品处理为 ${handlingLabel(change.oldItemHandling)}，保留费用 ${usd(change.oldItemCostCents)}。这笔费用已纳入本版本目标金额，不能再重复扣除。`, ["quote", "approval"]));
    }
    for (const event of line.supplierEvents) {
      const sourceId = `supplier:${event.id}`;
      sources.push({ id: sourceId, kind: "supplier", label: `Demo supplier ${event.kind} · ${event.reference}`, href: `${href}${lineAnchor(line)}`, recordedAt: event.createdAt });
      facts.push(fact(sourceId, `${line.label}: a demo ${event.kind === "credit_confirmed" ? "supplier credit" : "supplier confirmation"} for ${usd(event.totalCents)} was recorded by the designer at ${event.createdAt}. This is not a live supplier integration or a PayPal receipt.`, `${line.label}：设计师于 ${event.createdAt} 代录演示${event.kind === "credit_confirmed" ? "供应商回款" : "供应商确认"} ${usd(event.totalCents)}。这不是实时供应商接口，也不是 PayPal 交易回执。`, [sourceId, "quote"]));
    }
  }
  if (workspace.lines.length) {
    const totals = workspace.lines.reduce((sum, line) => ({ held: sum.held + line.heldCents, captured: sum.captured + line.capturedCents, refunded: sum.refunded + line.refundedCents, released: sum.released + line.releasedCents }), { held: 0, captured: 0, refunded: 0, released: 0 });
    facts.push(fact("scope", `For the shown payment items only: held ${usd(totals.held)}, completed captures ${usd(totals.captured)}, completed refunds ${usd(totals.refunded)}, released authorization ${usd(totals.released)}, net captured ${usd(totals.captured - totals.refunded)}. These are recorded Sandbox results, not a complete project settlement or a real-time PayPal balance. Pending results are not completed money.`, `仅本次显示的支付物品：授权余额 ${usd(totals.held)}，已完成扣款 ${usd(totals.captured)}，已完成退款 ${usd(totals.refunded)}，已释放授权 ${usd(totals.released)}，净扣款 ${usd(totals.captured - totals.refunded)}。这是已记录的 Sandbox 结果，不是整个项目已结清，也不是实时 PayPal 账户余额。待确认结果不计为已完成资金。`, [...new Set([...lineSources.values()].flat())]));
  } else {
    facts.push(fact("no-payment-records", "There are no displayed item payment records for this confirmed version. Approval does not prove payment; no full-project payment conclusion can be drawn.", "本确认版本没有可展示的物品支付记录。批准不证明付款，不能据此认定整个项目已付款。", ["quote", "approval"]));
    mandatoryFactIds.push("no-payment-records");
  }
  if (workspace.others.lineCount) {
    const included = new Set(workspace.plan?.lines.filter((line) => workspace.lines.some((shown) => shown.itemId === line.itemId && shown.side === line.side)).map((line) => `${line.side}:${line.itemId}`));
    const outside = workspace.plan?.lines.filter((line) => !included.has(`${line.side}:${line.itemId}`)) ?? [];
    const names = outside.map((line) => `${line.label} ${usd(line.targetCents)}`).join("; ");
    facts.push(fact("outside-scope", `${workspace.others.lineCount} unchanged quote line(s), totaling ${usd(workspace.others.targetCents)}, are outside these payment steps${names ? `: ${names}` : ""}. No payments are recorded for those lines in this workspace. Do not claim their quote amount has been paid or add it to shown net captures.`, `另有 ${workspace.others.lineCount} 项未变更报价，总额 ${usd(workspace.others.targetCents)}，未纳入这些支付步骤${names ? `：${names}` : ""}。本工作区没有这些条目的付款记录，不能认定该报价金额已支付，也不能把它加到本次净扣款中。`, ["quote"]));
    mandatoryFactIds.push("outside-scope");
  }
  if (workspace.plan?.status === "blocked") {
    facts.push(fact("funding-blockers", "The funding plan is blocked by incomplete or uncertain records. Displayed recorded amounts do not make the plan executable; reconcile existing operations and resolve the recorded blockers before starting any new money step.", "资金方案因记录不完整或结果不确定而受阻。显示已有金额不代表可以执行，应先核对已有操作并解决记录问题，再推进资金步骤。", ["quote", ...sources.filter((source) => source.id.startsWith("operation:")).map((source) => source.id)]));
    mandatoryFactIds.push("funding-blockers");
  }
  const providerRecordedAt = providerTimes.sort().at(-1) ?? null;
  facts.push(fact("record-freshness", `This answer reads stored Sandbox evidence at ${now.toISOString()}; the most recent recorded provider response is ${providerRecordedAt ?? "unavailable"}. No live PayPal query was made for this answer. Supplier confirmations are designer-entered demo records.`, `本回答于 ${now.toISOString()} 读取已保存的 Sandbox 依据，最近一次有记录的支付服务响应时间为 ${providerRecordedAt ?? "未知"}。本次回答没有实时查询 PayPal。供应商确认是设计师代录的演示记录。`, ["quote"]));
  if (!providerRecordedAt) {
    facts.push(fact("no-provider-records", "No stored PayPal response was found for this case. The displayed coverage is based on local records only and does not establish an actual PayPal balance or a completed payment.", "本项目未找到已保存的 PayPal 响应。显示的资金覆盖仅依据本地记录，不能据此确认实际 PayPal 余额或已完成付款。", ["quote"]));
    mandatoryFactIds.push("no-provider-records");
  }
  return { projectKey: key, quoteId, version: order.version, checkedAt: now.toISOString(), providerRecordedAt, mode: "recorded_sandbox", facts, sources, mandatoryFactIds };
}

function lineAnchor(line: PaymentLineView): string {
  return `#payment-line-${line.side}-${encodeURIComponent(line.itemId)}`;
}

function addLineSources(line: PaymentLineView, href: string, sources: MoneySource[]): string[] {
  const refs = ["quote", "approval"];
  for (const hold of line.holds) {
    const id = `hold:${hold.id}`;
    sources.push({ id, kind: "payment", label: `PayPal authorization ${hold.paypalAuthorizationId} · ${hold.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: hold.createdAt });
    refs.push(id);
  }
  for (const capture of line.captures) {
    const id = `capture:${capture.id}`;
    sources.push({ id, kind: "payment", label: `PayPal capture ${capture.paypalCaptureId} · ${capture.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: capture.createdAt });
    refs.push(id);
  }
  for (const refund of line.refunds) {
    const id = `refund:${refund.id}`;
    sources.push({ id, kind: "payment", label: `PayPal refund ${refund.paypalRefundId} · ${refund.status}`, href: `${href}${lineAnchor(line)}`, recordedAt: refund.createdAt });
    refs.push(id);
  }
  return refs;
}

function addNextFact(line: PaymentLineView, workspace: PaymentsWorkspace, refs: string[], facts: MoneyFact[]): void {
  const id = `next:${line.side}:${line.itemId}`;
  const open = workspace.operations.filter((operation) => !!line.businessItemId && operation.businessItemId === line.businessItemId && ["pending", "unknown"].includes(operation.status));
  const add = (en: string, zh: string, extra: string[] = []) => facts.push(fact(id, `${line.label}: ${en}`, `${line.label}：${zh}`, [...refs, ...extra]));
  if (open.length || line.captures.some((capture) => capture.status === "pending") || line.refunds.some((refund) => refund.status === "pending")) {
    add("a payment result is pending or unknown. Check the existing operation before treating it as completed or starting another step.", "有支付结果待确认或未知。应先核对已有操作，不能认定完成或直接重复执行。", open.map((operation) => `operation:${operation.id}`));
    return;
  }
  const net = line.capturedCents - line.refundedCents;
  if (net > line.targetCents) {
    const waitingCredit = line.refundRequiresSupplierCredit && !line.supplierEvents.some((event) => event.kind === "credit_confirmed");
    add(waitingCredit
      ? `${usd(net - line.targetCents)} remains to be refunded after the supplier credit is confirmed; it has not been returned yet. Another item's supplier confirmation does not satisfy this condition.`
      : `${usd(net - line.targetCents)} remains to be refunded from completed captures, subject to the current funding blockers; it has not been returned yet.`, waitingCredit
      ? `仍有 ${usd(net - line.targetCents)} 待退，须先确认本物品的供应商回款，尚未退回。其他物品供货完成不满足这项条件。`
      : `仍有 ${usd(net - line.targetCents)} 待从已完成扣款中退回，执行仍受当前资金阻塞条件约束，尚未退回。`);
  } else if (line.heldCents > 0 && net >= line.targetCents) {
    add(`${usd(line.heldCents)} of unused authorization remains to be released; releasing it is not a refund.`, `仍有 ${usd(line.heldCents)} 未使用授权待释放，释放不是退款。`);
  } else if (net + line.heldCents < line.targetCents) {
    add(`the approved target is still short of ${usd(line.targetCents - net - line.heldCents)} in recorded coverage. Its own additional authorization or payment is needed; a quote budget difference or another item's released hold does not pay for it.`, `已记录的资金覆盖距离获批目标还差 ${usd(line.targetCents - net - line.heldCents)}。需要本物品自己的追加授权或付款；报价差额和另一物品释放的授权不能算作本物品已付款。`);
  } else if (line.heldCents > 0) {
    const ordered = line.supplierEvents.some((event) => event.kind === "order_confirmed");
    add(ordered ? "the supplier confirmation has been recorded, but the held amount is not captured yet." : "the amount is authorized, not charged. Capture waits for this item's supplier confirmation.", ordered ? "已有供货确认，但授权金额尚未扣款。" : "金额已授权，尚未扣款。须等待本物品的供应商确认后才可扣款。");
  } else {
    add(`recorded net captures match the approved target of ${usd(line.targetCents)} and no authorization remains. This only describes this item's recorded state.`, `已记录的净扣款与获批目标 ${usd(line.targetCents)} 一致，且没有剩余授权。这只说明本物品的记录状态。`);
  }
}

function handlingLabel(value: FrozenChangeOrder["changes"][number]["oldItemHandling"]): string {
  return { pending: "待确认", not_ordered: "未下单", cancelled: "取消", returned: "退货", retained: "保留", not_applicable: "不适用" }[value];
}
