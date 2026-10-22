import type { ApprovedQuoteReport } from "@/quotes/types";
import type { MoneyAnswer, MoneyContext } from "../ai/money-types";

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
}

export interface StoredCase {
  id: string;
  projectKey: CaseKey;
  messages: CaseMessage[];
  draft: ChangeDraft | null;
  activeMessageId: string | null;
  /** Server-owned current approved baseline; optional for legacy store adapters. */
  quote?: ApprovedQuoteReport;
}

export interface CaseSnapshot extends StoredCase {
  quote: ApprovedQuoteReport;
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
}

export type BeginAiResult =
  | { status: "started"; runId: string; state: StoredCase }
  | { status: "busy" | "completed"; state: StoredCase };

export interface ChatStore {
  readMoneyContext?(sessionId: string, projectKey: CaseKey): Promise<MoneyContext>;
  getCase(sessionId: string, projectKey: CaseKey): Promise<StoredCase>;
  appendMessage(sessionId: string, projectKey: CaseKey, input: AppendMessageInput): Promise<StoredCase>;
  beginAi(sessionId: string, projectKey: CaseKey, messageId: string): Promise<BeginAiResult>;
  completeAi(sessionId: string, projectKey: CaseKey, messageId: string, runId: string, result: { text: string; draft?: ChangeDraft | null; moneyAnswer?: MoneyAnswer; model: string }): Promise<StoredCase>;
  failAi(sessionId: string, projectKey: CaseKey, messageId: string, runId: string, error: string): Promise<StoredCase>;
}
