import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { approvals, items, revisionLines, revisions } from "../db/schema";
import { chatCases, chatMessages } from "../chat/schema";
import { currentCaseQuote } from "../approval/baseline";
import { changeOrderDecisions } from "../approval/schema";
import { changeOrderView } from "../approval/view";
import { createChatStore } from "../chat/store";
import type { CaseKey, CaseMessage, ChangeDraft } from "../chat/types";
import { readOpening } from "../opening/read";
import { openingQuotes } from "../opening/schema";
import { quoteFingerprint } from "../quotes/fingerprint";
import type { ApprovedQuoteReport } from "../quotes/types";
import { createPricingInput, prepareChangeOrder, previewPricing, validatePricingInput, PricingValidationError } from "./calculation";
import { carryOverReview, type ReviewCarryOver } from "./carry-over";
import { changeOrders, pricingCases, pricingReviews } from "./schema";
import type { FrozenChangeOrder, PricingReview, PricingStore, PricingWorkspace } from "./types";
import { freezeRevision, insertBaseline } from "./bridge";
import { changeOrderContentHash, itemMappingKey } from "./document";
import { PricingStoreError } from "./errors";
export { changeOrderContentHash } from "./document";
export { PricingStoreError } from "./errors";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseRow = typeof chatCases.$inferSelect;
type ReviewRow = typeof pricingReviews.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * A new version closes V1, so every V1 line the client has not decided on comes
 * along in its draft. The draft is kept in step with V1; this guards an older draft.
 */
async function v1LinesLeftBehind(tx: Transaction, row: CaseRow): Promise<string | null> {
  const read = await readOpening(tx, row);
  if (!read.opening.sentAt || read.opening.closed) return null;
  const carried = new Set(row.draft?.changes.flatMap((change) => change.fromV1?.kind === "carried" ? [change.fromV1.itemId] : []) ?? []);
  const names = read.document.lines.filter((line) => read.lines[line.itemId].state === "pending" && !carried.has(line.itemId)).map((line) => line.name);
  if (!names.length) return null;
  return `${names.length === 1 ? "An undecided quote V1 line is" : `${names.length} undecided quote V1 lines are`} not in this draft (${names.join(", ")}). Re-price from the latest draft so ${names.length === 1 ? "it comes" : "they come"} along for the client's decision.`;
}

function withOpenV1<T extends { ready: boolean; problems: string[] }>(preview: T, undecided: string | null): T {
  return undecided ? { ...preview, ready: false, problems: [...preview.problems, undecided] } : preview;
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
  const draftMatchesQuote = !(sourceDraft?.basedOnQuoteFingerprint !== undefined && sourceDraft.basedOnQuoteFingerprint !== fingerprint);
  const stale = (!!stored && (!sameSource(stored, sourceDraft) || stored.input.baselineFingerprint !== fingerprint)) || !draftMatchesQuote;
  // A newer draft on the same baseline: the saved review moves onto it, keeping the designer's edits.
  let carryOver: ReviewCarryOver | null = null;
  if (stale && stored?.draftProposal && sourceDraft && draftMatchesQuote && stored.draftProposal.quoteId === quote.id) {
    try { carryOver = carryOverReview(quote, stored.draftProposal.input, stored.input, createPricingInput(quote, sourceDraft)); }
    catch { /* A draft that no longer prices against the quote is redrafted from the chat. */ }
  }
  const orders = await tx.select({ document: changeOrders.document, status: revisions.status }).from(changeOrders)
    .innerJoin(revisions, eq(changeOrders.revisionId, revisions.id)).where(eq(changeOrders.caseId, row.id)).orderBy(desc(revisions.number));
  return {
    caseId: row.id, projectKey: row.projectKey, quote, sourceDraft, review,
    preview: review && sourceDraft && (!stale || carryOver) ? withOpenV1(previewPricing(quote, sourceDraft, carryOver?.input ?? review.input), await v1LinesLeftBehind(tx, row)) : null,
    stale, carryOver,
    orders: orders.map(({ document, status }) => ({ id: document.id, version: document.version, issuedAt: document.issuedAt, totalCents: document.totals.totalCents, deltaTotalCents: document.deltaTotalCents, status: changeOrderView(document, status).status })),
  };
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
    // A V1 sent from the chat created the project when it was sent; the client's approved lines are its baseline.
    if (!firstOrder && (await tx.select({ caseId: openingQuotes.caseId }).from(openingQuotes).where(eq(openingQuotes.caseId, caseId))).length) return existing;
    if (!firstOrder || firstOrder.document.baselineFingerprint !== quoteFingerprint(quote)) {
      throw new PricingStoreError("PRICING_STALE_SOURCE", "This case already has a frozen V1 with different or unverified contents. Start a fresh demo case instead of reusing that baseline.");
    }
    return existing;
  }
  const { bridge, revisionHash, lineIds } = await insertBaseline(tx, caseId, quote);
  for (const line of quote.lines) {
    const { approval } = line;
    await tx.insert(approvals).values({ revisionId: bridge.baselineRevisionId, revisionLineId: lineIds.get(line.itemId)!, decision: "approved", approverName: approval.approvedBy, signature: approval.signature, contentHash: revisionHash, decidedAt: new Date(approval.approvedAt) });
  }
  // Import only the fixture's explicitly labelled demo approvals; never create a payment.
  await tx.update(revisions).set({ status: "approved" }).where(eq(revisions.id, bridge.baselineRevisionId));
  return bridge;
}

export function createPricingStore(db: Db): PricingStore {
  const chat = createChatStore(db);
  async function withinCase<T>(sessionId: string, key: CaseKey, work: (tx: Transaction, row: CaseRow, quote: ApprovedQuoteReport) => Promise<T>): Promise<T> {
    if (!UUID.test(sessionId) || !["willow", "maple"].includes(key)) throw new PricingStoreError("INVALID_INPUT", "A valid demo session and case are required.");
    await chat.getCase(sessionId, key); // Also recovers expired AI leases before taking the pricing lock.
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
      const quote = await currentCaseQuote(tx, row.id, key);
      if (!quote) throw new PricingStoreError("PRICING_NOT_FOUND", "The client has not approved any line of quote V1 yet, so there is nothing to change.");
      return work(tx, row, quote);
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
        const draftProposal = { quoteId: quote.id, input: createPricingInput(quote, draft) };
        if (old) {
          await tx.update(pricingReviews).set({ input, draftProposal, sourceDraftId: draft.id, sourceDraftRevision: draft.revision, version: old.version + 1, updatedAt: new Date() }).where(eq(pricingReviews.id, old.id));
        } else {
          await tx.insert(pricingReviews).values({ caseId: row.id, sourceDraftId: draft.id, sourceDraftRevision: draft.revision, version: 1, input, draftProposal });
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
        const leftBehind = await v1LinesLeftBehind(tx, row);
        if (leftBehind) throw new PricingStoreError("PRICING_STALE_SOURCE", "Undecided quote V1 lines are missing from this draft.", [leftBehind]);
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
