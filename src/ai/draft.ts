import { randomUUID } from "node:crypto";
import type { ApprovedQuoteLine, ApprovedQuoteReport } from "@/quotes/types";
import type { CaseMessage, ChangeDraft, DraftChange, DraftItem, ProductPage } from "@/chat/types";
import { aiOutputSchema } from "./output";
import { quoteFingerprint } from "@/quotes/fingerprint";

export class InvalidAiOutputError extends Error {}

function oldItem(line: ApprovedQuoteLine): DraftItem {
  return {
    name: line.name, vendor: line.vendor, brand: null, sku: line.sku,
    specification: line.specification, quantity: line.quantity,
    unitLabel: line.unitLabel ?? "each", unitPriceCents: line.unitPriceCents, currency: "USD",
  };
}

function subtotal(item: DraftItem | null): number | null {
  if (item === null) return 0;
  if (item.currency !== "USD" || item.unitPriceCents === null || !item.unitLabel) return null;
  const amount = item.quantity * item.unitPriceCents;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new InvalidAiOutputError("Unsafe calculated amount");
  return amount;
}

/** The model chooses changes; only trusted quote / parsed page fields supply prices. */
export function buildDraft(input: {
  output: unknown;
  quote: ApprovedQuoteReport;
  messages: CaseMessage[];
  pages: ProductPage[];
  current: ChangeDraft | null;
  triggerId: string;
  model: string;
  now?: string;
}): { text: string; draft?: ChangeDraft | null } {
  const output = aiOutputSchema.parse(input.output);
  const { quote, pages } = input;
  if (!input.messages.some((message) => message.id === input.triggerId && message.actor !== "assistant")) {
    throw new InvalidAiOutputError("Missing triggering message");
  }
  if (output.intent !== "draft") {
    if (output.changes.length) throw new InvalidAiOutputError("Non-draft output contains changes");
    if (output.intent === "cancel") {
      if (!input.current || input.current.projectKey !== quote.projectId) throw new InvalidAiOutputError("No current draft to cancel");
      return { text: output.message, draft: null };
    }
    return { text: output.message };
  }
  if (output.changes.length === 0) throw new InvalidAiOutputError("Draft has no changes");
  const humanIds = new Set(input.messages.filter((message) => message.actor !== "assistant").map((message) => message.id));
  const options = new Map(pages.filter((page) => !page.error).flatMap((page) => page.products.map((product) => [product.id, { product, page }] as const)));
  const touched = new Set<string>();
  const unresolved = [...output.unresolved];
  const changes: DraftChange[] = output.changes.map((change) => {
    for (const id of change.sourceMessageIds) {
      if (!humanIds.has(id)) throw new InvalidAiOutputError("Source message is not part of this case");
    }
    const sourceMessageIds = [...new Set([...change.sourceMessageIds, input.triggerId])];
    const line = quote.lines.find((item) => item.itemId === change.itemId);
    if (change.action !== "add" && !line) throw new InvalidAiOutputError("Unknown quote item");
    if (change.action === "add" && change.itemId !== null) throw new InvalidAiOutputError("Add cannot target an existing item");
    if (change.itemId) {
      if (touched.has(change.itemId)) throw new InvalidAiOutputError("Conflicting changes to the same item");
      touched.add(change.itemId);
    }
    if (change.action !== "remove" && change.quantity === null) throw new InvalidAiOutputError("Missing quantity");
    const before = line ? oldItem(line) : null;
    let after: DraftItem | null;
    if (change.action === "remove") {
      if (change.productOptionId || change.quantity !== null) throw new InvalidAiOutputError("Removal contains replacement data");
      after = null;
    } else if (change.action === "quantity") {
      if (change.productOptionId) throw new InvalidAiOutputError("Quantity change contains a replacement product");
      after = { ...before!, quantity: change.quantity! };
    } else {
      const candidate = change.productOptionId ? options.get(change.productOptionId) : null;
      if (change.productOptionId && !candidate) throw new InvalidAiOutputError("Product source does not exist");
      if (candidate) {
        const product = candidate.product;
        after = {
          name: product.name, brand: product.brand, vendor: product.seller,
          sku: product.sku, specification: product.specification,
          quantity: change.quantity!, unitLabel: product.unitLabel,
          unitPriceCents: product.unitPriceCents, currency: product.currency,
        };
        if (!product.sku) unresolved.push(`${product.name}: model or SKU needs designer confirmation.`);
        if (!product.priceEvidence) {
          after.unitPriceCents = null;
          unresolved.push(`${product.name}: the page price has no traceable source and needs pricing review.`);
        }
      } else {
        if (!change.description.trim()) throw new InvalidAiOutputError("Missing new product description");
        after = {
          name: change.description, vendor: null, brand: null, sku: null,
          specification: change.description, quantity: change.quantity!,
          unitLabel: null, unitPriceCents: null, currency: null,
        };
        unresolved.push(`${change.description}: new product details and price need confirmation.`);
      }
    }
    const beforeSubtotalCents = subtotal(before);
    const afterSubtotalCents = subtotal(after);
    const deltaSubtotalCents = beforeSubtotalCents === null || afterSubtotalCents === null ? null : afterSubtotalCents - beforeSubtotalCents;
    if (deltaSubtotalCents !== null && !Number.isSafeInteger(deltaSubtotalCents)) throw new InvalidAiOutputError("Unsafe delta");
    if (after && afterSubtotalCents === null) unresolved.push(`${after.name}: currency, pricing unit or price needs confirmation; the difference is not calculated yet.`);
    if (change.action === "replace" || change.action === "remove") unresolved.push(`${before!.name}: confirm whether the old item was purchased, whether it must be returned, and the handling cost.`);
    return { action: change.action, itemId: change.itemId, before, after, productOptionId: change.productOptionId, sourceMessageIds, beforeSubtotalCents, afterSubtotalCents, deltaSubtotalCents };
  });
  for (const page of pages.filter((page) => page.error)) unresolved.push(`Could not read product link ${page.url}. ${page.error}`);
  unresolved.push("Tax, delivery and other charges need designer verification. This is only a pre-tax preview of the goods and services difference.");
  const now = input.now ?? new Date().toISOString();
  const current = input.current;
  if (current && (current.projectKey !== quote.projectId || current.basedOnQuoteId !== quote.id || current.basedOnVersion !== quote.version)) {
    throw new InvalidAiOutputError("Current draft belongs to another quote");
  }
  const knownDeltas = changes.map((change) => change.deltaSubtotalCents);
  const delta = knownDeltas.every((value) => value !== null) ? knownDeltas.reduce<number>((sum, value) => sum + value!, 0) : null;
  if (delta !== null && !Number.isSafeInteger(delta)) throw new InvalidAiOutputError("Unsafe total delta");
  return {
    text: output.message,
    draft: {
      id: current?.id ?? randomUUID(), projectKey: quote.projectId as "willow" | "maple",
      basedOnQuoteId: quote.id, basedOnVersion: quote.version,
      basedOnQuoteFingerprint: quoteFingerprint(quote),
      revision: (current?.revision ?? 0) + 1, status: "needs_designer_review",
      title: output.title || "Change draft", summary: output.message, changes,
      sourceMessageIds: [...new Set(changes.flatMap((change) => change.sourceMessageIds))],
      sources: pages.map((page) => ({ ...page, text: "" })),
      unresolved: [...new Set(unresolved)], constraints: [...new Set(output.constraints)],
      deltaSubtotalCents: delta, createdAt: current?.createdAt ?? now, updatedAt: now, model: input.model,
    },
  };
}
