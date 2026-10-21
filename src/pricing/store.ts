import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals, items, projects, revisionLines, revisions } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { currentCaseQuote } from "../approval/baseline";
import { changeOrderDecisions } from "../approval/schema";
import { changeOrderView } from "../approval/view";
import { createChatStore } from "../chat/store";
import type { CaseKey, CaseMessage, ChangeDraft } from "../chat/types";
import { hashRevision } from "../quotes/hash";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { ApprovedQuoteReport } from "../quotes/types";
import { createPricingInput, prepareChangeOrder, previewPricing, validatePricingInput, PricingValidationError } from "./calculation";
import { changeOrders, pricingCases, pricingReviews } from "./schema";
import type { FrozenChangeOrder, PricingReview, PricingStore, PricingWorkspace } from "./types";
import { changeOrderContentHash, itemMappingKey } from "./document";
export { changeOrderContentHash } from "./document";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof chatCases.$inferSelect;
type ReviewRow = typeof pricingReviews.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PricingStoreError extends Error {
  constructor(readonly code: string, message: string, readonly problems?: string[]) {
    super(message);
    this.name = "PricingStoreError";
  }
}

function sameSource(review: Pick<PricingReview, "sourceDraftId" | "sourceDraftRevision">, draft: ChangeDraft | null): boolean {
  return !!draft && review.sourceDraftId === draft.id && review.sourceDraftRevision === draft.revision;
}

function publicReview(row: ReviewRow): PricingReview {
  return { id: row.id, sourceDraftId: row.sourceDraftId, sourceDraftRevision: row.sourceDraftRevision, version: row.version, input: row.input, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function currentReview(tx: Transaction, caseId: string): Promise<ReviewRow | undefined> {
  const [review] = await tx.select().from(pricingReviews).where(eq(pricingReviews.caseId, caseId)).for("update");
  return review;
}

function requireDraft(row: CaseRow, quote: ApprovedQuoteReport): ChangeDraft {
  if (row.activeRunId) throw new PricingStoreError("PRICING_BUSY", "Wait for the current AI reply before changing the pricing review.");
  const draft = row.draft;
  if (!draft) throw new PricingStoreError("PRICING_NOT_FOUND", "There is no current AI draft to review.");
  if (draft.projectKey !== row.projectKey || draft.basedOnQuoteId !== quote.id || draft.basedOnVersion !== quote.version || (draft.basedOnQuoteFingerprint !== undefined && draft.basedOnQuoteFingerprint !== quoteFingerprint(quote))) {
    throw new PricingStoreError("PRICING_STALE_SOURCE", "The draft no longer matches this case's baseline quote.");
  }
  try { createPricingInput(quote, draft); }
  catch (error) {
    throw new PricingStoreError("PRICING_STALE_SOURCE", "The AI draft was based on different quote contents. Return to the chat and regenerate it before pricing.", error instanceof PricingValidationError ? error.problems : undefined);
  }
  return draft;
}

async function workspace(tx: Transaction, row: CaseRow, quote: ApprovedQuoteReport): Promise<PricingWorkspace> {
  const stored = await currentReview(tx, row.id);
  const sourceDraft = row.draft;
  const now = new Date().toISOString();
  let review: PricingReview | null = stored ? publicReview(stored) : null;
  if (!stored && sourceDraft) {
    try {
      review = { id: randomUUID(), sourceDraftId: sourceDraft.id, sourceDraftRevision: sourceDraft.revision, version: 0, input: createPricingInput(quote, sourceDraft), createdAt: now, updatedAt: now };
    } catch (error) {
      throw new PricingStoreError("PRICING_STALE_SOURCE", "The AI draft no longer matches the current quote. Return to the chat and regenerate it before pricing.", error instanceof PricingValidationError ? error.problems : undefined);
    }
  }
  const fingerprint = quoteFingerprint(quote);
  const stale = (!!stored && (!sameSource(stored, sourceDraft) || stored.input.baselineFingerprint !== fingerprint)) || !!(sourceDraft?.basedOnQuoteFingerprint !== undefined && sourceDraft.basedOnQuoteFingerprint !== fingerprint);
  const orders = await tx.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
    .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).where(eq(changeOrders.caseId, row.id)).orderBy(desc(revisions.number));
  return {
    caseId: row.id, projectKey: row.projectKey, quote, sourceDraft, review,
    preview: review && sourceDraft && !stale ? previewPricing(quote, sourceDraft, review.input) : null,
    stale,
    orders: orders.map(({ document, status }) => ({ id: document.id, version: document.version, issuedAt: document.issuedAt, totalCents: document.totals.totalCents, deltaTotalCents: document.deltaTotalCents, status: changeOrderView(document, status).status })),
  };
}

/** Same freeze sequence as sendRevision, inside the issue transaction rather than a nested transaction. */
async function freezeRevision(tx: Transaction, revisionId: string): Promise<string> {
  const [revision] = await tx.select().from(revisions).where(eq(revisions.id, revisionId)).for("update");
  if (!revision || revision.status !== "draft") throw new PricingStoreError("PRICING_CONFLICT", "The business revision is no longer a draft.");
  const lines = await tx.select().from(revisionLines).where(eq(revisionLines.revisionId, revisionId));
  if (lines.length === 0) throw new PricingStoreError("PRICING_NOT_READY", "A change order must retain at least one quoted line.");
  const hash = hashRevision(lines);
  await tx.update(revisions).set({ status: "sent", contentHash: hash, sentAt: new Date() }).where(eq(revisions.id, revisionId));
  return hash;
}

async function businessBridge(tx: Transaction, caseId: string, quote: ApprovedQuoteReport) {
  const [existing] = await tx.select().from(pricingCases).where(eq(pricingCases.caseId, caseId)).for("update");
  if (existing) {
    if (existing.baselineQuoteId !== quote.id) {
      const [accepted] = await tx.select({ revisionId: changeOrders.revisionId }).from(changeOrders)
        .innerJoin(changeOrderDecisions, eq(changeOrderDecisions.orderId, changeOrders.id))
        .where(and(eq(changeOrders.caseId, caseId), eq(changeOrders.id, quote.id), eq(changeOrderDecisions.decision, "approved")));
      if (!accepted) throw new PricingStoreError("PRICING_STALE_SOURCE", "The approved baseline no longer belongs to this case.");
      return { ...existing, baselineRevisionId: accepted.revisionId };
    }
    const [firstOrder] = await tx.select({ document: changeOrders.document }).from(changeOrders).where(eq(changeOrders.caseId, caseId)).orderBy(asc(changeOrders.issuedAt)).limit(1);
    if (!firstOrder || firstOrder.document.baselineFingerprint !== quoteFingerprint(quote)) {
      throw new PricingStoreError("PRICING_STALE_SOURCE", "This case already has a frozen V1 with different or unverified contents. Start a fresh demo case instead of reusing that baseline.");
    }
    return existing;
  }
  const [project] = await tx.insert(projects).values({ name: `${quote.projectName} (demo pricing)`, space: quote.room, clientName: quote.clientName, currency: "USD" }).returning();
  const [baseline] = await tx.insert(revisions).values({ projectId: project.id, number: quote.version }).returning();
  const itemMapping: Record<string, string> = {};
  const baselineApprovals: { lineId: string; approval: ApprovedQuoteReport["lines"][number]["approval"] }[] = [];
  for (const line of quote.lines) {
    const [item] = await tx.insert(items).values({ projectId: project.id, name: line.name, vendor: line.vendor, kind: line.category, sourceUrl: line.source.url ?? null }).returning();
    itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })] = item.id;
    const [savedLine] = await tx.insert(revisionLines).values({
      revisionId: baseline.id, itemId: item.id, quantity: line.quantity, unitPriceCents: line.unitPriceCents,
      taxCents: line.taxCents, freightCents: line.freightCents, restockingFeeBps: line.restockingFeeBps,
      returnable: line.nonReturnable === null ? null : !line.nonReturnable, customMade: line.customMade, leadTimeDays: line.leadTimeDays,
    }).returning();
    baselineApprovals.push({ lineId: savedLine.id, approval: line.approval });
  }
  const baselineHash = await freezeRevision(tx, baseline.id);
  for (const { lineId, approval } of baselineApprovals) {
    await tx.insert(approvals).values({ revisionId: baseline.id, revisionLineId: lineId, decision: "approved", approverName: approval.approvedBy, signature: approval.signature, contentHash: baselineHash, decidedAt: new Date(approval.approvedAt) });
  }
  // Import only the fixture's explicitly labelled demo approvals; never create a payment.
  await tx.update(revisions).set({ status: "approved" }).where(eq(revisions.id, baseline.id));
  const [bridge] = await tx.insert(pricingCases).values({ caseId, projectId: project.id, baselineRevisionId: baseline.id, baselineQuoteId: quote.id, itemMapping }).returning();
  return bridge;
}

export function createPricingStore(db: Db): PricingStore {
  const chat = createChatStore(db);
  async function withinCase<T>(sessionId: string, key: CaseKey, work: (tx: Transaction, row: CaseRow, quote: ApprovedQuoteReport) => Promise<T>): Promise<T> {
    if (!UUID.test(sessionId) || !["willow", "maple"].includes(key)) throw new PricingStoreError("INVALID_INPUT", "A valid demo session and case are required.");
    await chat.getCase(sessionId, key); // Also recovers expired AI leases before taking the pricing lock.
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
      return work(tx, row, await currentCaseQuote(tx, row.id, key));
    });
  }

  return {
    getWorkspace(sessionId, key) {
      return withinCase(sessionId, key, workspace);
    },

    saveReview(sessionId, key, command) {
      return withinCase(sessionId, key, async (tx, row, quote) => {
        const draft = requireDraft(row, quote);
        if (command.sourceDraftId !== draft.id || command.sourceDraftRevision !== draft.revision) {
          throw new PricingStoreError("PRICING_STALE_SOURCE", "AI has updated the draft. Reset the review to the current draft before saving.");
        }
        if (command.input.baselineFingerprint !== quoteFingerprint(quote)) {
          throw new PricingStoreError("PRICING_STALE_SOURCE", "The baseline quote contents changed. Explicitly reset this pricing review before saving.");
        }
        const old = await currentReview(tx, row.id);
        if ((old?.version ?? null) !== command.expectedVersion) throw new PricingStoreError("PRICING_CONFLICT", "This pricing review was changed elsewhere. Reload it before saving.");
        let input;
        try { input = validatePricingInput(quote, draft, command.input); }
        catch (error) {
          throw new PricingStoreError("INVALID_INPUT", "Pricing fields do not match the current draft.", error instanceof PricingValidationError ? error.problems : undefined);
        }
        if (old) {
          await tx.update(pricingReviews).set({ input, sourceDraftId: draft.id, sourceDraftRevision: draft.revision, version: old.version + 1, updatedAt: new Date() }).where(eq(pricingReviews.id, old.id));
        } else {
          await tx.insert(pricingReviews).values({ caseId: row.id, sourceDraftId: draft.id, sourceDraftRevision: draft.revision, version: 1, input });
        }
        return workspace(tx, row, quote);
      });
    },

    issueReview(sessionId, key, command) {
      return withinCase(sessionId, key, async (tx, row, quote) => {
        if (!UUID.test(command.reviewId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) throw new PricingStoreError("INVALID_INPUT", "A saved pricing review and version are required.");
        const review = await currentReview(tx, row.id);
        if (!review || review.id !== command.reviewId) throw new PricingStoreError("PRICING_NOT_FOUND", "The review does not belong to this case.");
        const [issued] = await tx.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
          .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id))
          .where(and(eq(changeOrders.caseId, row.id), eq(changeOrders.reviewId, review.id), eq(changeOrders.reviewVersion, command.expectedVersion)));
        if (issued) {
          const [decision] = await tx.select().from(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, issued.document.id));
          return changeOrderView(issued.document, issued.status, decision);
        }
        const draft = requireDraft(row, quote);
        if (!sameSource(review, draft)) throw new PricingStoreError("PRICING_STALE_SOURCE", "AI has updated the source draft. Reset and save the pricing review before issuing.");
        if (review.input.baselineFingerprint !== quoteFingerprint(quote)) throw new PricingStoreError("PRICING_STALE_SOURCE", "The saved review is based on different or unverified quote contents. Reset and save it against the current baseline before issuing.");
        if (review.version !== command.expectedVersion) throw new PricingStoreError("PRICING_CONFLICT", "This pricing review was changed elsewhere. Reload it before issuing.");
        const preview = previewPricing(quote, draft, review.input);
        if (!preview.ready) throw new PricingStoreError("PRICING_NOT_READY", "Resolve the pricing checks before issuing.", preview.problems);
        const messageRows = await tx.select().from(chatMessages).where(eq(chatMessages.caseId, row.id)).orderBy(asc(chatMessages.sequence));
        const messages: CaseMessage[] = messageRows.map((message) => ({ id: message.id, actor: message.actor, text: message.text, createdAt: message.createdAt.toISOString(), replyToMessageId: message.replyToMessageId, aiState: message.aiState, error: message.error, model: message.model }));
        let body;
        try { body = prepareChangeOrder(quote, draft, review.input, messages); }
        catch (error) {
          throw new PricingStoreError("PRICING_NOT_READY", "The change order could not be prepared from this review.", error instanceof PricingValidationError ? error.problems : undefined);
        }
        const bridge = await businessBridge(tx, row.id, quote);
        const [lastRevision] = await tx.select().from(revisions).where(eq(revisions.projectId, bridge.projectId)).orderBy(desc(revisions.number)).limit(1);
        const [revision] = await tx.insert(revisions).values({ projectId: bridge.projectId, number: lastRevision.number + 1, basedOnRevisionId: bridge.baselineRevisionId }).returning();
        const mapping = { ...bridge.itemMapping };
        for (const line of body.lines) {
          const mappingKey = itemMappingKey(line);
          if (!mapping[mappingKey]) {
            const [item] = await tx.insert(items).values({ projectId: bridge.projectId, name: line.name, vendor: line.vendor, kind: line.category, sourceUrl: line.sourceUrl }).returning();
            mapping[mappingKey] = item.id;
          }
          await tx.insert(revisionLines).values({ revisionId: revision.id, itemId: mapping[mappingKey], quantity: line.quantity, unitPriceCents: line.unitPriceCents, taxCents: line.taxCents, freightCents: line.freightCents, restockingFeeBps: line.restockingFeeBps, returnable: line.returnable, customMade: line.customMade, leadTimeDays: line.leadTimeDays });
        }
        const revisionContentHash = await freezeRevision(tx, revision.id);
        const issuedAt = new Date();
        const withoutHash: Omit<FrozenChangeOrder, "contentHash"> = {
          ...body, id: randomUUID(), version: revision.number, issuedAt: issuedAt.toISOString(), reviewId: review.id, reviewVersion: review.version, revisionId: revision.id, revisionContentHash,
        };
        // JSON roundtrip freezes the serialisable document and removes any optional undefined properties.
        const clean = JSON.parse(JSON.stringify(withoutHash)) as Omit<FrozenChangeOrder, "contentHash">;
        const document: FrozenChangeOrder = { ...clean, contentHash: changeOrderContentHash(clean) };
        await tx.update(revisions).set({ status: "superseded" }).where(and(eq(revisions.projectId, bridge.projectId), eq(revisions.status, "sent"), ne(revisions.id, revision.id)));
        await tx.update(pricingCases).set({ itemMapping: mapping }).where(eq(pricingCases.caseId, row.id));
        await tx.insert(changeOrders).values({ id: document.id, caseId: row.id, reviewId: review.id, reviewVersion: review.version, revisionId: revision.id, contentHash: document.contentHash, document, issuedAt });
        return changeOrderView(document, "sent");
      });
    },

    async getOrder(id) {
      if (!UUID.test(id)) return null;
      const [found] = await db.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
        .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).where(eq(changeOrders.id, id));
      if (!found) return null;
      const [decision] = await db.select().from(changeOrderDecisions).where(eq(changeOrderDecisions.orderId, id));
      return changeOrderView(found.document, found.status, decision);
    },
  };
}
