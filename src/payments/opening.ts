/**
 * The payment entry for a V1 the client signed line by line, before any change
 * order exists. Like `lockConfirmedVersion`, it locks the demo case, checks that
 * the caller's session owns it, and returns exactly what the client signed: the
 * open V1, both hashes, and the business items of the approved lines. Declined
 * and undecided lines are not part of the agreement and are never funded. Once
 * a newer version replaces V1, payments start from that version instead.
 */
import { and, eq } from "drizzle-orm";
import { buildOpeningPlan, type FundingPlan } from "../approval/funding";
import { ledgerFacts, readLedger, type FundingIdentity, type ProjectLedger } from "../approval/store";
import { chatCases } from "../chat/schema";
import type { CaseKey } from "../chat/types";
import { revisions } from "../db/schema";
import { readOpening } from "../opening/read";
import { sentFromChat } from "../opening/types";
import { itemMappingKey } from "../pricing/document";
import { pricingCases } from "../pricing/schema";
import { calculateLineTotals } from "../quotes/totals";
import type { QuoteLine } from "../quotes/types";
import { PaymentActionError, type Tx } from "./binding";
import type { OperationBinding } from "./operations";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpeningVersion {
  caseId: string;
  projectId: string;
  revisionId: string;
  /** Hash of the V1 document the client signed. */
  contentHash: string;
  revisionContentHash: string;
  /** The approved lines, each with its business item UUID. */
  approved: { line: QuoteLine; itemId: string }[];
  /** The binding an operation for this business item carries (none for the design-services hold). */
  bind(itemId: string | null): OperationBinding;
}

/** Locks the case and loads its open V1. `shown` is the V1 hash the caller saw, when it acts on what it showed. */
export async function lockOpeningVersion(tx: Tx, sessionId: string, key: CaseKey, shown: { contentHash: string } | null): Promise<OpeningVersion> {
  if (!UUID.test(sessionId)) throw new PaymentActionError("FORBIDDEN", "Open this project from the browser that owns the demo case.");
  const [row] = await tx.select().from(chatCases).where(and(eq(chatCases.sessionId, sessionId), eq(chatCases.projectKey, key))).for("update");
  const read = row ? await readOpening(tx, row) : null;
  const [bridge] = row ? await tx.select().from(pricingCases).where(eq(pricingCases.caseId, row.id)) : [];
  if (!sentFromChat(key) && !bridge?.baselineQuote) throw new PaymentActionError("NOT_FOUND", "This project's quote was approved before Setti. Payments start from its confirmed versions.");
  if (!row || !read?.revision || !read.opening.contentHash || !bridge) throw new PaymentActionError("NOT_FOUND", "Quote V1 has not been sent in this demo project yet.");
  const [revision] = await tx.select().from(revisions).where(eq(revisions.id, read.revision.id)).for("share");
  if (revision.status !== "sent") throw new PaymentActionError("STALE_VERSION", "A newer version replaced quote V1. Start payment steps from that version.");
  if (shown && shown.contentHash !== read.opening.contentHash) throw new PaymentActionError("CONTENT_CHANGED", "The displayed quote no longer matches the signed V1. Reload before starting a payment step.");

  const approved = read.document.lines.flatMap((line) => {
    const itemId = bridge.itemMapping[itemMappingKey({ ...line, sourceUrl: line.source.url ?? null })];
    return read.lines[line.itemId].state === "approved" && read.decisions.get(line.itemId)?.decision === "approved" && itemId ? [{ line, itemId }] : [];
  });
  if (!approved.length) throw new PaymentActionError("NOT_CONFIRMED", "Payment steps start after the client approves at least one line of quote V1.");
  const contentHash = read.opening.contentHash, revisionContentHash = revision.contentHash!;
  return {
    caseId: row.id, projectId: bridge.projectId, revisionId: revision.id, contentHash, revisionContentHash, approved,
    bind: (itemId) => ({ changeOrderId: null, revisionId: revision.id, contentHash, revisionContentHash, itemId }),
  };
}

/** The project's recorded money and the plan it gives for the approved V1 lines. */
export async function openingPlan(tx: Tx, version: OpeningVersion): Promise<{ ledger: ProjectLedger; plan: FundingPlan }> {
  const ledger = await readLedger(tx, version.projectId);
  const identities = new Map<string, FundingIdentity>(version.approved.map(({ line, itemId }) => [itemId, { itemId: line.itemId, side: "baseline" }]));
  const lines = version.approved.map(({ line }) => ({ itemId: line.itemId, label: line.name, category: line.category, targetCents: calculateLineTotals(line).totalCents }));
  return { ledger, plan: buildOpeningPlan({ id: version.revisionId, contentHash: version.contentHash }, lines, ledgerFacts(identities, [], ledger, null)) };
}
