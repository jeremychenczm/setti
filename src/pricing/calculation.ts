import { z } from "zod";
import type { ApprovedQuoteLine, ApprovedQuoteReport } from "@/quotes/types";
import { calculateLineTotals, calculateQuoteTotals, type QuoteTotals } from "../quotes/totals";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { CaseMessage, ChangeDraft, DraftChange } from "@/chat/types";
import type { FinalQuoteLine, PricingChangeInput, PricingDocumentBody, PricingInput, PricingItem, PricingPreview, ReviewedChange } from "./types";

const MAX_CENTS = 2_000_000_000;
const cents = z.number().int().min(0).max(MAX_CENTS);
const text = (max: number) => z.string().max(max);
const sourceUrl = z.string().max(4096).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "来源链接须为不含登录凭据的 HTTPS 地址").nullable();

export const pricingInputSchema = z.strictObject({
  baselineFingerprint: z.string().min(1).max(1_000_000),
  title: text(300),
  changes: z.array(z.strictObject({
    key: z.string().min(1).max(100),
    action: z.enum(["quantity", "remove", "replace", "add"]),
    itemId: z.string().min(1).max(300).nullable(),
    after: z.strictObject({
      name: text(500), vendor: text(500), brand: text(300).nullable(), sku: text(300),
      specification: text(10_000), category: z.enum(["furniture", "service"]), room: text(500),
      quantity: z.number().int().min(1).max(10_000), unitLabel: text(100), currency: text(12).nullable(),
      unitPriceCents: cents.nullable(), taxCents: cents.nullable(), freightCents: cents.nullable(),
      sourceUrl, returnPolicy: text(10_000), returnable: z.boolean().nullable(),
      restockingFeeBps: z.number().int().min(0).max(10_000).nullable(),
      customMade: z.boolean(), leadTimeDays: z.number().int().min(0).max(36_500).nullable(),
    }).nullable(),
    priceEvidence: text(30_000), confirmed: z.boolean(),
    oldItemHandling: z.enum(["pending", "not_ordered", "cancelled", "returned", "retained", "not_applicable"]),
    oldItemCostCents: cents.nullable(), oldItemNote: text(10_000),
  })).min(1).max(100),
  issues: z.array(z.strictObject({ id: z.string().min(1).max(100), label: text(10_000), resolved: z.boolean(), note: text(10_000) })).max(300),
  terms: text(30_000), reviewNotes: text(20_000),
});

export class PricingValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[] | string) {
    const entries = typeof problems === "string" ? [problems] : problems;
    super(entries.join("；"));
    this.name = "PricingValidationError";
    this.problems = [...entries];
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
export function requiresOldItemHandling(change: { action: DraftChange["action"]; itemId: string | null; after: { quantity: number } | null }, before?: ApprovedQuoteLine): boolean {
  return change.action === "replace" || change.action === "remove" || (change.action === "quantity" && before !== undefined && change.after !== null && change.after.quantity < before.quantity);
}

function baseline(quote: ApprovedQuoteReport, draft: ChangeDraft): Map<string, ApprovedQuoteLine> {
  if (draft.basedOnQuoteId !== quote.id || draft.basedOnVersion !== quote.version || draft.projectKey !== quote.projectId) throw new PricingValidationError("变更草稿与当前批准报价不一致，请重新核价。");
  if (draft.basedOnQuoteFingerprint !== undefined && draft.basedOnQuoteFingerprint !== quoteFingerprint(quote)) throw new PricingValidationError("原批准报价内容已变化；请在聊天重新 @AI 生成草稿并重新核价。");
  if (!draft.changes.length || draft.changes.length > 100) throw new PricingValidationError("变更草稿必须包含 1 至 100 行变更。");
  const byId = new Map(quote.lines.map((line) => [line.itemId, line]));
  if (byId.size !== quote.lines.length) throw new PricingValidationError("原批准报价含重复物品编号。");
  const touched = new Set<string>();
  for (const change of draft.changes) {
    if (change.action === "add") {
      if (change.itemId !== null) throw new PricingValidationError("新增条目不能指向原报价物品。");
    } else {
      if (!change.itemId || !byId.has(change.itemId) || touched.has(change.itemId)) throw new PricingValidationError("变更引用了未知或重复的原报价物品。");
      touched.add(change.itemId);
      if (draft.basedOnQuoteFingerprint === undefined) {
        const previous = byId.get(change.itemId)!;
        const before = change.before;
        if (!before || before.name !== previous.name || before.vendor !== previous.vendor || before.sku !== previous.sku || before.specification !== previous.specification || before.quantity !== previous.quantity || before.unitLabel !== (previous.unitLabel ?? "each") || before.unitPriceCents !== previous.unitPriceCents || before.currency !== "USD") throw new PricingValidationError("旧草稿的原物品与当前批准报价不一致；请在聊天重新 @AI 生成草稿。");
      }
    }
    if ((change.action === "remove") !== (change.after === null)) throw new PricingValidationError("变更类型与草稿的新条目不一致。");
  }
  return byId;
}

/** Draft prices are suggestions. Tax, delivery and human confirmation start unknown. */
export function createPricingInput(quote: ApprovedQuoteReport, draft: ChangeDraft): PricingInput {
  const old = baseline(quote, draft);
  return {
    baselineFingerprint: quoteFingerprint(quote),
    title: draft.title,
    changes: draft.changes.map((change, index) => {
      const previous = change.itemId ? old.get(change.itemId) : undefined;
      const source = draft.sources.find((page) => !page.error && page.products.some((product) => product.id === change.productOptionId));
      const product = source?.products.find((option) => option.id === change.productOptionId);
      const after = change.after;
      const price = after?.unitPriceCents;
      const needsOldHandling = requiresOldItemHandling(change, previous);
      return {
        key: `change-${index}`, action: change.action, itemId: change.itemId,
        after: after ? {
          name: after.name, vendor: after.vendor ?? "", brand: after.brand, sku: after.sku ?? "",
          specification: after.specification, category: previous?.category ?? "furniture", room: previous?.room ?? quote.room,
          quantity: after.quantity, unitLabel: after.unitLabel ?? "", currency: after.currency,
          unitPriceCents: price !== null && price !== undefined && Number.isSafeInteger(price) && price >= 0 && price <= MAX_CENTS ? price : null,
          taxCents: null, freightCents: null,
          sourceUrl: source?.url ?? (change.action === "quantity" ? previous?.source.url ?? null : null),
          returnPolicy: change.action === "quantity" ? previous?.returnPolicy ?? "" : "",
          returnable: change.action === "quantity" && previous?.nonReturnable !== null && previous?.nonReturnable !== undefined ? !previous.nonReturnable : null,
          restockingFeeBps: change.action === "quantity" ? previous?.restockingFeeBps ?? null : null,
          customMade: change.action === "quantity" ? previous?.customMade ?? false : false,
          leadTimeDays: change.action === "quantity" ? previous?.leadTimeDays ?? null : null,
        } : null,
        priceEvidence: product?.priceEvidence ?? (change.action === "quantity" && previous ? JSON.stringify({ source: previous.source, sku: previous.sku, unitPriceCents: previous.unitPriceCents, unitLabel: previous.unitLabel ?? null }) : ""),
        confirmed: false,
        oldItemHandling: needsOldHandling ? "pending" : "not_applicable",
        oldItemCostCents: needsOldHandling ? null : 0,
        oldItemNote: "",
      };
    }),
    issues: draft.unresolved.map((label, index) => ({ id: `issue-${index}`, label, resolved: false, note: "" })),
    terms: "", reviewNotes: "",
  };
}

/** Shape and immutable identity checks apply even when saving an incomplete review. */
export function validatePricingInput(quote: ApprovedQuoteReport, draft: ChangeDraft, value: unknown): PricingInput {
  const old = baseline(quote, draft);
  const input = pricingInputSchema.parse(value);
  if (input.baselineFingerprint !== quoteFingerprint(quote)) throw new PricingValidationError("原批准报价内容已变化；这份核价不能沿用，请重新核价。");
  const source = createPricingInput(quote, draft);
  const changes = new Map(input.changes.map((change) => [change.key, change]));
  if (changes.size !== input.changes.length || changes.size !== source.changes.length) throw new PricingValidationError("核价条目不能新增、删除或重复；请基于原变更草稿核价。");
  const ordered = source.changes.map((expected) => {
    const actual = changes.get(expected.key);
    if (!actual || actual.action !== expected.action || actual.itemId !== expected.itemId || (actual.after === null) !== (expected.after === null)) throw new PricingValidationError("核价条目的编号、操作或原物品不能被修改。");
    if (actual.action === "quantity") {
      const previous = old.get(actual.itemId!)!;
      const after = actual.after!;
      if (after.name !== previous.name || after.vendor !== previous.vendor || after.sku !== previous.sku || after.specification !== previous.specification || after.category !== previous.category || after.unitLabel !== (previous.unitLabel ?? "each")) throw new PricingValidationError("数量变更不能换成另一商品或计价单位；换款请在聊天重新 @AI 生成替换草稿。");
    }
    if (requiresOldItemHandling(actual, actual.itemId ? old.get(actual.itemId) : undefined)) {
      if (actual.oldItemHandling === "not_applicable") throw new PricingValidationError("替换、移除或减少数量必须核实旧款处理方式。");
    } else if (actual.oldItemHandling !== "not_applicable" || actual.oldItemCostCents !== 0) throw new PricingValidationError("新增数量或新增物品不应包含旧款处理费用。");
    return actual;
  });
  const issues = new Map(input.issues.map((issue) => [issue.id, issue]));
  if (issues.size !== input.issues.length || issues.size !== source.issues.length) throw new PricingValidationError("待确认问题不能新增、删除或重复。");
  const orderedIssues = source.issues.map((expected) => {
    const actual = issues.get(expected.id);
    if (!actual || actual.label !== expected.label) throw new PricingValidationError("待确认问题的编号或原文不能修改。");
    return actual;
  });
  return { ...input, changes: ordered, issues: orderedIssues };
}

function unchanged(line: ApprovedQuoteLine): FinalQuoteLine {
  return {
    itemId: line.itemId, name: line.name, vendor: line.vendor, brand: null, sku: line.sku,
    specification: line.specification, category: line.category, room: line.room,
    quantity: line.quantity, unitLabel: line.unitLabel ?? "each", currency: "USD", unitPriceCents: line.unitPriceCents,
    taxCents: line.taxCents, freightCents: line.freightCents, sourceUrl: line.source.url ?? null,
    returnPolicy: line.returnPolicy, returnable: line.nonReturnable === null ? null : !line.nonReturnable,
    restockingFeeBps: line.restockingFeeBps, customMade: line.customMade, leadTimeDays: line.leadTimeDays,
    origin: "unchanged",
  };
}

function finalAfter(draft: ChangeDraft, change: PricingChangeInput): FinalQuoteLine | null {
  if (!change.after) return null;
  const item = change.after;
  if (item.currency !== "USD" || item.unitPriceCents === null || item.taxCents === null || item.freightCents === null) return null;
  return { ...clone(item), itemId: change.itemId ?? `new-${draft.id}-${change.key}`, currency: "USD", unitPriceCents: item.unitPriceCents, taxCents: item.taxCents, freightCents: item.freightCents, origin: "changed" };
}

function feeLine(draft: ChangeDraft, change: PricingChangeInput, before: ApprovedQuoteLine): FinalQuoteLine {
  return {
    itemId: `old-cost-${draft.id}-${change.key}`, name: `旧款保留与处理成本：${before.name}`, vendor: before.vendor,
    brand: null, sku: `OLD-COST-${change.key}`,
    specification: `${change.oldItemNote.trim()}。本行包含旧款保留、取消或退货的全部已核实成本及适用税费，按整项金额收取，不再次计税或配送。`,
    category: "service", room: before.room, quantity: 1, unitLabel: "total", currency: "USD",
    unitPriceCents: change.oldItemCostCents!, taxCents: 0, freightCents: 0, sourceUrl: null,
    returnPolicy: "本行是经设计师核实的旧款处理总成本；具体处理和退回安排以本次条款及旧款处理说明为准。",
    returnable: null, restockingFeeBps: null, customMade: false, leadTimeDays: null, origin: "old_item_cost",
  };
}

function assembledLines(quote: ApprovedQuoteReport, draft: ChangeDraft, input: PricingInput): FinalQuoteLine[] | null {
  const byItem = new Map(input.changes.filter((change) => change.itemId).map((change) => [change.itemId, change]));
  const lines: FinalQuoteLine[] = [];
  for (const before of quote.lines) {
    const change = byItem.get(before.itemId);
    if (!change) { lines.push(unchanged(before)); continue; }
    if (change.after) {
      const after = finalAfter(draft, change);
      if (!after) return null;
      lines.push(after);
    }
    if (requiresOldItemHandling(change, before)) {
      if (change.oldItemCostCents === null) return null;
      if (change.oldItemCostCents > 0) lines.push(feeLine(draft, change, before));
    }
  }
  for (const change of input.changes.filter((entry) => entry.action === "add")) {
    const after = finalAfter(draft, change);
    if (!after) return null;
    lines.push(after);
  }
  return lines;
}

function boundedTotals(lines: readonly { quantity: number; unitPriceCents: number; taxCents: number; freightCents: number }[]) {
  for (const line of lines) {
    const values = [line.unitPriceCents, line.taxCents, line.freightCents, calculateLineTotals(line).totalCents];
    if (values.some((amount) => amount > MAX_CENTS)) throw new PricingValidationError("条目金额超过安全上限，请拆分或重新核实报价。");
  }
  const totals = calculateQuoteTotals(lines);
  if ([totals.subtotalCents, totals.taxCents, totals.freightCents, totals.totalCents].some((amount) => amount > MAX_CENTS)) throw new PricingValidationError("报价总金额超过安全上限，请重新核实。");
  return totals;
}

function commercialValue(line: FinalQuoteLine): string {
  return JSON.stringify([line.itemId, line.name.trim(), line.vendor.trim(), line.brand, line.sku.trim(), line.specification.trim(), line.category, line.room.trim(), line.quantity, line.unitLabel.trim(), line.currency, line.unitPriceCents, line.taxCents, line.freightCents, line.returnPolicy.trim(), line.returnable, line.restockingFeeBps, line.customMade, line.leadTimeDays]);
}

function noCommercialChange(quote: ApprovedQuoteReport, lines: FinalQuoteLine[]): boolean {
  const old = quote.lines.map((line) => commercialValue(unchanged(line))).sort();
  const proposed = lines.map(commercialValue).sort();
  return JSON.stringify(old) === JSON.stringify(proposed);
}

/** Missing metadata may coexist with a known amount; missing money never becomes zero. */
export function previewPricing(quote: ApprovedQuoteReport, draft: ChangeDraft, value: PricingInput): PricingPreview {
  const baselineTotals = boundedTotals(quote.lines);
  let input: PricingInput;
  try { input = validatePricingInput(quote, draft, value); }
  catch (error) {
    const problems = error instanceof PricingValidationError ? error.problems : error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) : ["核价资料不合法。"];
    return { baselineTotals, proposedTotals: null, deltaTotalCents: null, problems, ready: false };
  }
  const problems: string[] = [];
  const originalCurrencies = new Map(draft.changes.map((change, index) => [`change-${index}`, change.after?.currency ?? null]));
  const initialEvidence = new Map(createPricingInput(quote, draft).changes.map((change) => [change.key, change.priceEvidence]));
  if (!input.title.trim()) problems.push("请填写变更单标题。");
  if (!input.terms.trim()) problems.push("请填写本次报价与旧款处理条款。");
  for (const change of input.changes) {
    const label = change.after?.name.trim() || quote.lines.find((line) => line.itemId === change.itemId)?.name || change.key;
    if (!change.confirmed) problems.push(`${label}：设计师尚未确认本行核价。`);
    if (change.after) {
      const item = change.after;
      const required: [keyof PricingItem, string][] = [["name", "名称"], ["vendor", "供应商"], ["sku", "货号"], ["specification", "规格"], ["room", "房间"], ["unitLabel", "计价单位"], ["returnPolicy", "退货或取消条款"]];
      for (const [key, name] of required) if (typeof item[key] !== "string" || !(item[key] as string).trim()) problems.push(`${label}：${name}待确认。`);
      if (item.currency !== "USD") problems.push(`${label}：需明确核实美元报价，不能自动换算未知或外币价格。`);
      if (item.unitPriceCents === null) problems.push(`${label}：单价待确认。`);
      if (item.taxCents === null) problems.push(`${label}：本行税额待确认。`);
      if (item.freightCents === null) problems.push(`${label}：本行配送费待确认。`);
      if (!change.priceEvidence.trim()) problems.push(`${label}：请填写核价依据。`);
      if (originalCurrencies.get(change.key) !== "USD" && item.currency === "USD" && change.priceEvidence.trim() === initialEvidence.get(change.key)?.trim()) problems.push(`${label}：原币种并非已确认美元，请补充本次美元核价依据，不能只修改币种标签。`);
    }
    const before = quote.lines.find((line) => line.itemId === change.itemId);
    if (requiresOldItemHandling(change, before)) {
      if (change.oldItemHandling === "pending" || change.oldItemHandling === "not_applicable") problems.push(`${label}：旧款处理方式待确认。`);
      if (change.oldItemCostCents === null) problems.push(`${label}：旧款全部处理成本待确认，免费也需明确填 0。`);
      if (!change.oldItemNote.trim()) problems.push(`${label}：请填写旧款处理及费用说明。`);
      const retainedMinimum = change.action === "quantity" ? (before!.quantity - change.after!.quantity) * before!.unitPriceCents : calculateLineTotals(before!).totalCents;
      if (change.oldItemHandling === "retained" && change.oldItemCostCents !== null && change.oldItemCostCents < retainedMinimum) problems.push(change.action === "quantity" ? `${label}：保留被减少的旧数量，其成本至少应包含被减少数量的原单价合计；相关税与配送需在说明中另行核实。` : `${label}：保留旧款的成本至少应包含原报价整行总额（含原税和配送）。`);
    }
  }
  for (const issue of input.issues) if (!issue.resolved || !issue.note.trim()) problems.push(`${issue.label}：需勾选已解决并填写核实说明。`);
  const lines = assembledLines(quote, draft, input);
  let proposedTotals: QuoteTotals | null = null;
  let deltaTotalCents: number | null = null;
  if (lines) {
    if (!lines.length) problems.push("新报价至少需保留一行；整项目取消不在本轮范围内。");
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) problems.push("新报价的物品编号存在冲突。");
    try {
      proposedTotals = boundedTotals(lines);
      deltaTotalCents = proposedTotals.totalCents - baselineTotals.totalCents;
      if (!Number.isSafeInteger(deltaTotalCents)) throw new PricingValidationError("报价差额不在安全范围内。");
      if (noCommercialChange(quote, lines)) problems.push("未修改任何报价内容；无需生成变更单。");
    } catch (error) { problems.push(error instanceof Error ? error.message : "报价金额不合法。"); proposedTotals = null; deltaTotalCents = null; }
  }
  return { baselineTotals, proposedTotals, deltaTotalCents, problems, ready: problems.length === 0 && lines !== null && lines.length > 0 && proposedTotals !== null };
}

/** Snapshot one complete V2; this creates neither a client approval nor a payment. */
export function prepareChangeOrder(quote: ApprovedQuoteReport, draft: ChangeDraft, value: PricingInput, messages: readonly CaseMessage[]): PricingDocumentBody {
  const input = validatePricingInput(quote, draft, value);
  const preview = previewPricing(quote, draft, input);
  if (!preview.ready || !preview.proposedTotals || preview.deltaTotalCents === null) throw new PricingValidationError(preview.problems.length ? preview.problems : ["核价资料未齐全，暂不能发出变更单。"]);
  const lines = assembledLines(quote, draft, input)!;
  const sources = new Set([...draft.sourceMessageIds, ...draft.changes.flatMap((change) => change.sourceMessageIds)]);
  const sourceMessages = messages.filter((message) => sources.has(message.id));
  if (new Set(sourceMessages.map((message) => message.id)).size !== sources.size || sourceMessages.length !== sources.size || sourceMessages.some((message) => message.actor === "assistant")) throw new PricingValidationError("变更引用的聊天原文缺失、重复或并非人工消息，请重新核对来源。");
  const reviewed: ReviewedChange[] = input.changes.map((change) => ({
    key: change.key, action: change.action, itemId: change.itemId,
    before: change.itemId ? clone(quote.lines.find((line) => line.itemId === change.itemId)!) : null,
    after: finalAfter(draft, change), oldItemHandling: change.oldItemHandling,
    oldItemCostCents: change.oldItemCostCents ?? 0, oldItemNote: change.oldItemNote,
    priceEvidence: change.priceEvidence,
  }));
  return clone({
    projectKey: draft.projectKey, basedOnQuoteId: quote.id, basedOnVersion: quote.version, baselineFingerprint: input.baselineFingerprint,
    projectName: quote.projectName, clientName: quote.clientName, designerName: quote.designerName,
    currency: "USD", isDemo: true, title: input.title, sourceDraftId: draft.id, sourceDraftRevision: draft.revision,
    changes: reviewed, lines, baselineLines: [...quote.lines], baselineTotals: preview.baselineTotals,
    totals: preview.proposedTotals, deltaTotalCents: preview.deltaTotalCents,
    terms: input.terms, reviewNotes: input.reviewNotes, issues: input.issues, constraints: [...draft.constraints],
    sourceMessages: sourceMessages.map(({ id, actor, text, createdAt }) => ({ id, actor, text, createdAt })),
    sources: draft.sources,
  });
}
