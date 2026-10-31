import { describe, expect, it } from "vitest";
import type { CaseMessage, ChangeDraft, SentVersion } from "@/chat/types";
import type { OperationView, PaymentLineView, PaymentsWorkspace } from "@/payments/types";
import { HOME_DISCUSSION, HOME_LEGACY_SCENARIO, HOME_SCENARIO } from "@/demo/living-dining";
import { mapleChangeLines, mapleGuideStep, type MapleGuideData } from "./maple-guide";

const at = "2026-10-24T12:00:00Z";
const version = (patch: Partial<SentVersion> = {}): SentVersion => ({ id: "seed-v2", version: 2, basedOnVersion: 1, title: "Prepared version", messageId: "seed-message", issuedAt: at, changeCount: 2, totalCents: 150_000, deltaTotalCents: 0, status: "approved", fromCurrentDraft: true, ...patch });
const line = (patch: Partial<PaymentLineView> = {}): PaymentLineView => ({ itemId: "chair", businessItemId: "old-chair", side: "baseline", label: "Lounge chair", category: "furniture", changed: true, change: "replace", targetCents: 0, heldCents: 0, capturedCents: 0, refundedCents: 0, releasedCents: 80_000, holds: [], captures: [], refunds: [], confirmedTerms: null, supplierEvents: [], steps: [], ...patch });
const operation = (patch: Partial<OperationView> = {}): OperationView => ({ id: "capture-op", businessItemId: "desk", kind: "capture", status: "succeeded", amountCents: 110_000, itemLabel: "Desk", version: 3, requestId: "request", attempts: 1, paypalOrderId: "ORDER", approvalUrl: null, paypalResourceId: "CAPTURE", failureCode: null, failureMessage: null, createdAt: at, updatedAt: at, calls: [], ...patch });
const message = (patch: Partial<CaseMessage> = {}): CaseMessage => ({ id: "message", actor: "client", text: "@AI change the chair", createdAt: at, replyToMessageId: null, aiState: "none", error: null, model: null, ...patch });
const draft = (): ChangeDraft => ({ id: "draft", projectKey: "maple", basedOnQuoteId: "seed-v2", basedOnVersion: 2, revision: 1, status: "needs_designer_review", title: "Desk and rug", summary: "Needs review", changes: [], sourceMessageIds: [], sources: [], unresolved: [], constraints: [], deltaSubtotalCents: null, createdAt: at, updatedAt: at, model: "test-model" });

function initial(): MapleGuideData {
  return { seedOrderId: "seed-v2", snapshot: { messages: [], activeMessageId: null, draft: draft(), versions: [version()], aiConfigured: true }, pricing: null, payments: null };
}

function confirmed(): MapleGuideData {
  const data = initial();
  data.snapshot.versions = [version(), version({ id: "visitor-v3", version: 3, basedOnVersion: 2 })];
  const payments: PaymentsWorkspace = {
    projectKey: "maple", orderId: "visitor-v3", version: 3, current: true, canAct: true, canReconcile: true, reason: null, environment: "sandbox",
    plan: { orderId: "visitor-v3", contentHash: "hash", basedOnVersion: 2, version: 3, quoteDeltaCents: 6_000, factsAsOf: at, status: "preview", executable: false, current: { heldCents: 0, capturedCents: 140_000, refundedCents: 24_000 }, money: { newAuthorizationCents: 0, releaseCents: 0, chargeCents: 0, refundCents: 0 }, lines: [], actions: [], blockers: [], notices: [] },
    lines: [line(), line({ side: "proposed", businessItemId: "desk", label: "Desk", targetCents: 110_000, capturedCents: 110_000, releasedCents: 0 }), line({ itemId: "rug", businessItemId: "rug", label: "Wool rug", change: "remove", targetCents: 6_000, capturedCents: 30_000, refundedCents: 24_000, releasedCents: 0 })],
    others: { lineCount: 1, targetCents: 40_000 }, operations: [operation()],
  };
  data.payments = payments;
  return data;
}

describe("Maple demo guide from saved records", () => {
  it("does not mistake the prepared scripted draft and V2 approval for visitor progress", () => {
    expect(mapleGuideStep(initial(), "designer")).toMatchObject({ index: 0, role: "emma", destination: "chat" });
  });

  it("routes a new draft and a client's redacted draft to designer pricing", () => {
    const data = initial();
    data.snapshot.versions![0].fromCurrentDraft = false;
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 1, role: "jordan", destination: "pricing" });
    data.snapshot.draft = null;
    data.snapshot.draftPreparing = true;
    expect(mapleGuideStep(data, "client")).toMatchObject({ index: 1, role: "jordan" });
  });

  it("points a stale saved V2 review to explicit adoption before sample materials or price confirmation", () => {
    const data = initial();
    data.snapshot.versions![0].fromCurrentDraft = false;
    data.pricing = { review: null, preview: null, stale: true };
    const step = mapleGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 1, role: "jordan", destination: "pricing", anchor: "pricing-source-status", title: "Adopt the latest draft before reviewing its prices" });
    expect(step.detail).toContain("Re-price from the latest draft");
    expect(step.detail).toContain("before checking the rows");
    expect(step.detail).toContain("does not confirm prices or send a client version");
  });

  it("stops requesting adoption after the current form explicitly adopts the latest draft, even before save", () => {
    const data = initial();
    data.snapshot.versions![0].fromCurrentDraft = false;
    data.pricing = { review: null, preview: null, stale: true };
    data.pricingViewStale = false;
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 1, destination: "pricing", title: "Jordan checks the proposed change" });
    expect(mapleGuideStep(data, "designer").anchor).toBeUndefined();
  });

  it("sends only the issued visitor version to Emma's independent confirmation", () => {
    const data = initial();
    data.snapshot.versions!.push(version({ id: "visitor-v3", version: 3, status: "awaiting_client_confirmation" }));
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 2, role: "emma", destination: "order", orderId: "visitor-v3", anchor: "client-decision-title" });
  });

  it("does not infer completed money from an approval or a missing plan", () => {
    const data = confirmed();
    data.payments = null;
    expect(mapleGuideStep(data, "client")).toMatchObject({ index: 3, role: "emma" });
    data.payments = confirmed().payments;
    data.payments!.plan = null;
    expect(mapleGuideStep(data, "designer").index).toBe(3);
  });

  it.each(["pending", "unknown"] as const)("keeps %s outcomes on the payment step even with settled-looking balances", (status) => {
    const data = confirmed();
    data.payments!.operations = [operation({ status })];
    expect(mapleGuideStep(data, "designer").index).toBe(3);
    expect(mapleGuideStep(data, "designer").complete).toBeUndefined();
  });

  it("keeps a pending refund open and excludes the unrelated design-service total", () => {
    const data = confirmed();
    data.payments!.lines[2].refunds = [{ id: "refund", paypalRefundId: "REFUND", captureId: "CAP", amountCents: 24_000, status: "pending", operationId: "refund-op", createdAt: at }];
    data.payments!.lines.push(line({ itemId: "service", changed: false, category: "service", targetCents: 40_000, capturedCents: 0 }));
    expect(mapleChangeLines(data.payments!)).toHaveLength(3);
    expect(mapleGuideStep(data, "designer").index).toBe(3);
  });

  it("asks for an explanation only after the independent item money is settled", () => {
    expect(mapleGuideStep(confirmed(), "client")).toMatchObject({ index: 4, role: "emma", destination: "chat", complete: false, chatAction: "ask-payments" });
  });

  it("requires an evidence answer at least as fresh as the stored payment operations", () => {
    const data = confirmed();
    data.snapshot.messages = [message({ actor: "assistant", moneyAnswer: { quoteId: "visitor-v3", version: 3, checkedAt: "2026-10-23T12:00:00Z", providerRecordedAt: at, mode: "recorded_sandbox", facts: [], sources: [] } })];
    expect(mapleGuideStep(data, "designer").complete).toBe(false);
    data.snapshot.messages[0].moneyAnswer!.checkedAt = at;
    expect(mapleGuideStep(data, "designer")).toMatchObject({ complete: true, action: "View payment explanation", anchor: `case-message-${data.snapshot.messages[0].id}` });
    expect(mapleGuideStep(data, "designer").chatAction).toBeUndefined();
  });

  it("keeps the completed money step visible while the AI prepares the evidence reply", () => {
    const data = confirmed();
    data.snapshot.activeMessageId = "money-question";
    expect(mapleGuideStep(data, "client")).toMatchObject({ index: 4, title: "The AI is preparing the payment explanation" });
    expect(mapleGuideStep(data, "client").chatAction).toBeUndefined();
  });

  it("guides the client to an uncovered replacement authorization", () => {
    const data = confirmed();
    data.payments!.lines[1].capturedCents = 0;
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 3, role: "emma" });
  });
});

describe("living-and-dining demo guide", () => {
  function homeInitial(): MapleGuideData {
    const data = initial();
    data.scenario = HOME_SCENARIO;
    data.seedOrderId = null;
    data.snapshot.draft = null;
    data.snapshot.messages = HOME_DISCUSSION.map((entry, index) => message({ id: `discussion-${index}`, actor: entry.actor, text: entry.text }));
    data.snapshot.versions = [];
    return data;
  }

  it("starts with Jordan's AI request after the saved discussion, whichever role opened the project", () => {
    for (const currentRole of ["designer", "client"] as const) {
      const step = mapleGuideStep(homeInitial(), currentRole);
      expect(step).toMatchObject({ index: 0, role: "jordan", destination: "chat", action: "Continue the discussion", title: "From the discussion to a revised quote" });
      expect(step.detail).toContain("Prepare the revised quote in Jordan's chat");
      expect(step.complete).toBeUndefined();
    }
  });

  it("keeps the prepared approved V2 and its scripted draft out of visitor confirmation and payment progress", () => {
    const data = homeInitial();
    data.scenario = HOME_LEGACY_SCENARIO;
    data.seedOrderId = "seed-v2";
    data.snapshot.versions = [version({ title: "Prepared living-and-dining baseline", changeCount: 0, totalCents: 773_000 })];
    data.snapshot.draft = { ...draft(), title: "Prepared living-and-dining baseline" };
    data.payments = confirmed().payments;
    data.payments!.orderId = "seed-v2";
    data.payments!.version = 2;
    const step = mapleGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 0, role: "jordan", destination: "chat" });
    expect(step.orderId).toBeUndefined();
    expect(step.complete).toBeUndefined();
    // Only a later version issued for the visitor enters Emma's confirmation step.
    data.snapshot.versions!.push(version({ id: "home-visitor-v3", version: 3, fromCurrentDraft: true, status: "awaiting_client_confirmation" }));
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 2, role: "emma", destination: "order", orderId: "home-visitor-v3" });
  });

  it("moves a new AI draft, including its client-redacted state, to Jordan's five-change pricing review", () => {
    const data = homeInitial();
    data.snapshot.draft = { ...draft(), origin: "designer", title: "Living-and-dining revision" };
    const step = mapleGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 1, role: "jordan", destination: "pricing", action: "Review pricing", title: "Jordan reviews the AI's five proposed changes" });
    expect(step.detail).toContain("sample supplier documents");
    expect(step.detail).toContain("all five changes, the sideboard return cost and the unchanged design fee");
    expect(step.complete).toBeUndefined();
    data.snapshot.draft = null;
    data.snapshot.draftPreparing = true;
    expect(mapleGuideStep(data, "client")).toMatchObject({ index: 1, role: "jordan", destination: "pricing", title: "Jordan reviews the AI's five proposed changes" });
  });

  it("preserves the client-led chair-and-rug request and generic pricing review for legacy runs", () => {
    const data = initial();
    data.scenario = "maple-mixed-change-v1";
    const step = mapleGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 0, role: "emma", destination: "chat", title: "Emma asks for one change affecting two items" });
    expect(step.detail).toContain("replace the lounge chair with a desk and return the rug");
    expect(step.detail).not.toContain("living and dining");
    data.snapshot.versions![0].fromCurrentDraft = false;
    const pricing = mapleGuideStep(data, "designer");
    expect(pricing).toMatchObject({ index: 1, role: "jordan", destination: "pricing", title: "Jordan checks the proposed change" });
    expect(pricing.detail).not.toContain("sideboard");
  });

  it("treats the first issued V2 as the client's new agreement after an approved V1", () => {
    const data = homeInitial();
    data.snapshot.versions = [version({ id: "visitor-v2", version: 2, basedOnVersion: 1, status: "awaiting_client_confirmation" })];
    expect(mapleGuideStep(data, "designer")).toMatchObject({ index: 2, role: "emma", orderId: "visitor-v2", action: "Review and confirm V2" });
  });

  it("allows pricing review during background setup without asking to send the version yet", () => {
    const data = homeInitial();
    data.preparationPending = true;
    data.snapshot.draft = { ...draft(), basedOnQuoteId: "v1", basedOnVersion: 1, origin: "designer" };
    const step = mapleGuideStep(data, "designer");
    expect(step).toMatchObject({ index: 1, destination: "pricing", action: "Review pricing" });
    expect(step.detail).toContain("You can save the review now");
    expect(step.detail).toContain("when the starting payment records are ready");
  });
});
