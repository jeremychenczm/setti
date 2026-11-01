import type { ApprovedQuoteReport, QuoteLine } from "@/quotes/types";
import type { MoneyAnswer, MoneyContext } from "../ai/money-types";
import type { OpeningQuote, QuoteView } from "../opening/types";
import type { ChangeSource } from "../pricing/types";

export type CaseKey = "willow" | "maple";
export type HumanActor = "designer" | "client";
export type AiState = "none" | "running" | "completed" | "failed";

export interface CaseMessage {
  id: string;
  actor: HumanActor | "assistant";
  text: string;
  createdAt: string;
  replyToMessageId: string | null;
  aiState: AiState;
  error: string | null;
  model: string | null;
  moneyAnswer?: MoneyAnswer | null;
  /** The V1 line this message asks about. */
  aboutItemId?: string | null;
}

export interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  brand: string | null;
  seller: string | null;
  specification: string;
  currency: string | null;
  unitPriceCents: number | null;
  unitLabel: string | null;
  priceEvidence: string | null;
  availability: string | null;
}

export interface ProductPage {
  id: string;
  url: string;
  fetchedAt: string;
  title: string;
  text: string;
  products: ProductOption[];
  error: string | null;
}

export interface DraftItem {
  name: string;
  vendor: string | null;
  brand: string | null;
  sku: string | null;
  specification: string;
  quantity: number;
  unitLabel: string | null;
  unitPriceCents: number | null;
  currency: string | null;
}

/**
 * A V1 line a new version brings back: one the client declined and the designer
 * revises, or one the client has not decided on, carried over for a decision.
 */
export interface FromV1 {
  itemId: string;
  kind: "revised" | "carried";
  /** The client's reason for declining a revised line. */
  reason: string | null;
}

/** What a supplier's order confirmation states besides the quantity and unit price, which the change's new line carries. */
export interface SupplierTerms {
  reference: string;
  taxCents: number;
  freightCents: number;
  leadTimeDays: number | null;
}

export interface DraftChange {
  action: "quantity" | "remove" | "replace" | "add";
  itemId: string | null;
  before: DraftItem | null;
  after: DraftItem | null;
  productOptionId: string | null;
  sourceMessageIds: string[];
  beforeSubtotalCents: number | null;
  afterSubtotalCents: number | null;
  deltaSubtotalCents: number | null;
  /** Set on a line that comes back from V1, with that line as it was sent. */
  fromV1?: FromV1 & { line: QuoteLine };
  /** Set when the designer starts the change from a supplier's order confirmation that differs from the line. */
  supplier?: SupplierTerms;
}

export interface ChangeDraft {
  id: string;
  projectKey: CaseKey;
  basedOnQuoteId: string;
  basedOnVersion: number;
  basedOnQuoteFingerprint?: string;
  revision: number;
  status: "needs_designer_review";
  title: string;
  summary: string;
  changes: DraftChange[];
  sourceMessageIds: string[];
  sources: ProductPage[];
  unresolved: string[];
  constraints: string[];
  deltaSubtotalCents: number | null;
  createdAt: string;
  updatedAt: string;
  model: string;
  /** The human who requested the proposal; model names do not establish authorship. */
  origin?: HumanActor;
  /** Set when the draft starts from a supplier's order confirmation: the supplier, and what its confirmation changes. */
  supplierNotice?: { vendor: string; notice: string };
}

/** A later quote version the designer sent into the chat, as its card shows it. */
export interface SentVersion {
  id: string;
  version: number;
  basedOnVersion: number;
  title: string;
  /** The designer's message it was sent with; null for a version issued before sending moved into the chat. */
  messageId: string | null;
  issuedAt: string;
  changeCount: number;
  totalCents: number;
  deltaTotalCents: number;
  status: "awaiting_client_confirmation" | "approved" | "declined" | "superseded";
  /** Issued from the case's current draft as it stands now. */
  fromCurrentDraft: boolean;
  /** Why the version changes the agreement; absent on versions issued before sources were recorded. */
  source?: ChangeSource;
}

/** Where a running reply is: reading the project, writing, checking against the records, or correcting itself. */
export type AiStage = "reading" | "writing" | "checking" | "rewriting";

export interface StoredCase {
  id: string;
  projectKey: CaseKey;
  messages: CaseMessage[];
  draft: ChangeDraft | null;
  activeMessageId: string | null;
  /** Set while a reply runs; optional for legacy store adapters. */
  activeRunStage?: AiStage | null;
  /** Server-owned current approved baseline; optional for legacy store adapters. */
  quote?: ApprovedQuoteReport;
  /** Where the project's V1 is with the client; optional for legacy store adapters. */
  opening?: OpeningQuote;
  /** Versions after V1, oldest first; optional for legacy store adapters. */
  versions?: SentVersion[];
}

export interface CaseSnapshot extends Omit<StoredCase, "quote" | "opening"> {
  /** Null until the client approves part of a V1 sent from the chat. */
  quote: ApprovedQuoteReport | null;
  /** For a client account: the designer is working on a draft the client does not see. */
  draftPreparing?: boolean;
  opening: OpeningQuote;
  aiConfigured: boolean;
}

export interface ChatErrorResponse {
  error: string;
  code: string;
  state?: CaseSnapshot;
}

export interface AppendMessageInput {
  id: string;
  actor: HumanActor;
  text: string;
  /** Tags the message with a line of the sent V1. */
  aboutItemId?: string;
}

/** The designer's message that carries V1; `sentBy` is the demo account's name. */
export interface SendQuoteInput {
  id: string;
  text: string;
  sentBy: string;
}

export type BeginAiResult =
  | { status: "started"; runId: string; state: StoredCase }
  | { status: "busy" | "completed"; state: StoredCase };

export interface ChatStore {
  readMoneyContext?(sessionId: string, projectKey: CaseKey): Promise<MoneyContext>;
  getCase(sessionId: string, projectKey: CaseKey): Promise<StoredCase>;
  /** Records the running reply's stage; ignored once that run has ended. */
  reportAiStage?(sessionId: string, projectKey: CaseKey, runId: string, stage: AiStage): Promise<void>;
  appendMessage(sessionId: string, projectKey: CaseKey, input: AppendMessageInput): Promise<StoredCase>;
  /** Freezes the prepared V1 and posts it as the designer's message; repeating it changes nothing. */
  sendQuote(sessionId: string, projectKey: CaseKey, input: SendQuoteInput): Promise<StoredCase>;
  getQuote(sessionId: string, projectKey: CaseKey): Promise<QuoteView>;
  beginAi(sessionId: string, projectKey: CaseKey, messageId: string): Promise<BeginAiResult>;
  completeAi(sessionId: string, projectKey: CaseKey, messageId: string, runId: string, result: { text: string; draft?: ChangeDraft | null; moneyAnswer?: MoneyAnswer; model: string }): Promise<StoredCase>;
  failAi(sessionId: string, projectKey: CaseKey, messageId: string, runId: string, error: string): Promise<StoredCase>;
}
