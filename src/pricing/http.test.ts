import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDraft } from "@/ai/draft";
import { willowApprovedQuote } from "@/quotes/willow-quote";
import { createPricingInput } from "./calculation";
import { PricingStoreError } from "./store";
import { getChangeOrderResponse, getPricingResponse, issuePricingResponse, savePricingResponse } from "./http";

const mock = vi.hoisted(() => ({ getWorkspace: vi.fn(), saveReview: vi.fn(), issueReview: vi.fn(), getOrder: vi.fn() }));
vi.mock("./server", () => ({ pricingStore: () => mock }));

const messageId = randomUUID();
const draft = buildDraft({
  quote: willowApprovedQuote,
  messages: [{ id: messageId, actor: "designer", text: "@AI 餐椅改成6把", createdAt: new Date().toISOString(), replyToMessageId: null, aiState: "completed", error: null, model: null }],
  pages: [], current: null, triggerId: messageId, model: "test-only",
  output: { intent: "draft", message: "餐椅数量变更", title: "餐椅6把", changes: [{ action: "quantity", itemId: "willow-lisabo-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: [messageId] }], unresolved: [], constraints: ["其他不动"] },
}).draft!;

function saveBody() {
  return { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: null, input: createPricingInput(willowApprovedQuote, draft) };
}

function request(path: string, method = "GET", body?: unknown, cookie?: string, origin = "http://localhost:3002") {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "Content-Type": "application/json", Origin: origin } : {}), ...(cookie ? { Cookie: `setti-demo-chat=${cookie}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("pricing HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getWorkspace.mockResolvedValue({ projectKey: "willow", review: null, sourceDraft: draft, orders: [] });
    mock.saveReview.mockResolvedValue({ projectKey: "willow", review: { version: 1 } });
    mock.issueReview.mockResolvedValue({ order: { id: randomUUID(), version: 2 }, status: "awaiting_client_confirmation" });
  });

  it("reuses the scoped chat cookie and sets an opaque HttpOnly cookie for a new browser", async () => {
    const response = await getPricingResponse(request("/api/pricing/willow"), "willow");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mock.getWorkspace.mock.calls[0][0]).toMatch(/^[\da-f-]{36}$/);
    const session = randomUUID();
    await getPricingResponse(request("/api/pricing/willow", "GET", undefined, session), "willow");
    expect(mock.getWorkspace).toHaveBeenLastCalledWith(session, "willow");
  });

  it("saves unknown fees without silently turning them into zero and sends the source/version guard", async () => {
    const body = saveBody();
    expect(body.input.changes[0].after?.taxCents).toBeNull();
    const session = randomUUID();
    const response = await savePricingResponse(request("/api/pricing/willow", "PUT", body, session), "willow");
    expect(response.status).toBe(200);
    expect(mock.saveReview).toHaveBeenCalledWith(session, "willow", body);
  });

  it("rejects unknown cases, injected approval/payment fields, and malformed amounts before writing", async () => {
    expect((await getPricingResponse(request("/api/pricing/other"), "other")).status).toBe(404);
    expect(mock.getWorkspace).not.toHaveBeenCalled();
    for (const body of [{ ...saveBody(), approved: true }, { ...saveBody(), actor: "designer" }, { ...saveBody(), expectedVersion: 0 }]) {
      expect((await savePricingResponse(request("/api/pricing/willow", "PUT", body), "willow")).status).toBe(400);
    }
    const invalid = saveBody();
    invalid.input.changes[0].after!.unitPriceCents = -1;
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", invalid), "willow")).status).toBe(400);
    const badUrl = saveBody();
    badUrl.input.changes[0].after!.sourceUrl = "not-a-url";
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", badUrl), "willow")).status).toBe(400);
    expect(mock.saveReview).not.toHaveBeenCalled();
  });

  it("issues only a saved review version, never accepts a client total or forged content hash", async () => {
    const body = { reviewId: randomUUID(), expectedVersion: 1 };
    const session = randomUUID();
    expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", body, session), "willow")).status).toBe(200);
    expect(mock.issueReview).toHaveBeenCalledWith(session, "willow", body);
    for (const extra of [{ totalCents: 1 }, { contentHash: "forged" }, { approved: true }]) {
      expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", { ...body, ...extra }), "willow")).status).toBe(400);
    }
    expect(mock.issueReview).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin writes and oversized bodies", async () => {
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", saveBody(), undefined, "https://other.example"), "willow")).status).toBe(403);
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", { note: "x".repeat(262145) }), "willow")).status).toBe(413);
    expect(mock.saveReview).not.toHaveBeenCalled();
  });

  it("returns actionable conflicts and redacts unexpected storage errors", async () => {
    mock.issueReview.mockRejectedValueOnce(new PricingStoreError("PRICING_CONFLICT", "核价已在其他页面更新。"));
    expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", { reviewId: randomUUID(), expectedVersion: 1 }), "willow")).status).toBe(409);
    mock.saveReview.mockRejectedValueOnce(new Error("postgres password=do-not-return SELECT private_data"));
    const response = await savePricingResponse(request("/api/pricing/willow", "PUT", saveBody()), "willow");
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/password|SELECT|private_data/);
  });

  it("exposes only read-only document lookup by a valid opaque id and does not set an edit cookie", async () => {
    expect((await getChangeOrderResponse(request("/api/change-orders/not-an-id"), "not-an-id")).status).toBe(404);
    expect(mock.getOrder).not.toHaveBeenCalled();
    const id = randomUUID();
    mock.getOrder.mockResolvedValueOnce(null);
    expect((await getChangeOrderResponse(request(`/api/change-orders/${id}`), id)).status).toBe(404);
    mock.getOrder.mockResolvedValueOnce({ order: { id, version: 2 }, status: "awaiting_client_confirmation" });
    const response = await getChangeOrderResponse(request(`/api/change-orders/${id}`), id);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect((await response.json()).order.id).toBe(id);
  });
});
