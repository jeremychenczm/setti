import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDraft } from "@/ai/draft";
import type { Actor } from "@/http/identity";
import { clientActor, designerActor } from "@/http/testing";
import { approvedForTest } from "@/opening/testing";

const willowApprovedQuote = approvedForTest("willow");
import { createPricingInput } from "./calculation";
import { PricingStoreError } from "./store";
import { getChangeOrderResponse, getPricingResponse, issuePricingResponse, postLineChangeResponse, savePricingResponse } from "./http";

const mock = vi.hoisted(() => ({ getWorkspace: vi.fn(), saveReview: vi.fn(), issueReview: vi.fn(), getOrder: vi.fn(), startLineChange: vi.fn(), requestActor: vi.fn() }));
vi.mock("./server", () => ({ pricingStore: () => mock, pricingDb: () => ({}) }));
vi.mock("./line-change", () => ({ startLineChange: mock.startLineChange }));
vi.mock("@/http/actor", () => ({ requestActor: mock.requestActor }));

/** The designer's studio, where the project's data lives. */
const studio = randomUUID();
const signIn = (actor: Actor | null) => mock.requestActor.mockResolvedValue(actor);

const messageId = randomUUID();
const draft = buildDraft({
  quote: willowApprovedQuote,
  messages: [{ id: messageId, actor: "designer", text: "@Setti Change the dining chairs to 6", createdAt: new Date().toISOString(), replyToMessageId: null, aiState: "completed", error: null, model: null }],
  pages: [], current: null, triggerId: messageId, model: "test-only",
  output: { intent: "draft", message: "Dining chair quantity change", title: "Six dining chairs", changes: [{ action: "quantity", itemId: "willow-dining-chair", quantity: 6, productOptionId: null, description: "", sourceMessageIds: [messageId] }], unresolved: [], constraints: ["Keep the rest unchanged"] },
}).draft!;

function saveBody() {
  return { sourceDraftId: draft.id, sourceDraftRevision: draft.revision, expectedVersion: null, input: createPricingInput(willowApprovedQuote, draft) };
}

function request(path: string, method = "GET", body?: unknown, origin = "http://localhost:3002") {
  return new NextRequest(`http://localhost:3002${path}`, {
    method,
    headers: method !== "GET" ? { "Content-Type": "application/json", Origin: origin } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("pricing HTTP boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn(designerActor(studio));
    mock.getWorkspace.mockResolvedValue({ projectKey: "willow", review: null, sourceDraft: draft, orders: [] });
    mock.saveReview.mockResolvedValue({ projectKey: "willow", review: { version: 1 } });
    mock.issueReview.mockResolvedValue({ order: { id: randomUUID(), version: 2 }, status: "awaiting_client_confirmation" });
  });

  it.each(["127.0.0.1:3002", "localhost:3002"])("accepts pricing from the browser's actual %s origin", async (host) => {
    const req = request("/api/pricing/willow", "PUT", saveBody(), "http://" + host);
    req.headers.set("host", host);
    expect((await savePricingResponse(req, "willow")).status).toBe(200);
    expect(mock.saveReview).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, opaque or forged pricing origins", async () => {
    for (const origin of [null, "null", "http://localhost:3002", "https://attacker.example"]) {
      const req = request("/api/pricing/willow", "PUT", saveBody());
      req.headers.set("host", "127.0.0.1:3002");
      if (origin === null) req.headers.delete("origin"); else req.headers.set("origin", origin);
      expect((await savePricingResponse(req, "willow")).status).toBe(403);
    }
    expect(mock.saveReview).not.toHaveBeenCalled();
  });

  it("keeps the pricing review to the designer: a client gets the change order once it is issued", async () => {
    for (const [actor, status] of [[clientActor(studio, ["willow"]), 403], [null, 401]] as const) {
      signIn(actor);
      expect((await getPricingResponse(request("/api/pricing/willow"), "willow")).status).toBe(status);
      expect((await savePricingResponse(request("/api/pricing/willow", "PUT", saveBody()), "willow")).status).toBe(status);
      expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", { reviewId: randomUUID(), expectedVersion: 1 }), "willow")).status).toBe(status);
    }
    expect(mock.getWorkspace).not.toHaveBeenCalled();
    expect(mock.saveReview).not.toHaveBeenCalled();
    expect(mock.issueReview).not.toHaveBeenCalled();
  });
  it("reads the designer's own studio, never cached and without setting a cookie", async () => {
    const response = await getPricingResponse(request("/api/pricing/willow"), "willow");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mock.getWorkspace).toHaveBeenLastCalledWith(studio, "willow");
    const other = randomUUID();
    signIn(designerActor(other));
    await getPricingResponse(request("/api/pricing/willow"), "willow");
    expect(mock.getWorkspace).toHaveBeenLastCalledWith(other, "willow");
  });

  it("saves unknown fees without silently turning them into zero and sends the source/version guard", async () => {
    const body = saveBody();
    expect(body.input.changes[0].after?.taxCents).toBeNull();
    const response = await savePricingResponse(request("/api/pricing/willow", "PUT", body), "willow");
    expect(response.status).toBe(200);
    expect(mock.saveReview).toHaveBeenCalledWith(studio, "willow", body);
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
    expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", body), "willow")).status).toBe(200);
    expect(mock.issueReview).toHaveBeenCalledWith(studio, "willow", body);
    for (const extra of [{ totalCents: 1 }, { contentHash: "forged" }, { approved: true }]) {
      expect((await issuePricingResponse(request("/api/pricing/willow/issue", "POST", { ...body, ...extra }), "willow")).status).toBe(400);
    }
    expect(mock.issueReview).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin writes and oversized bodies", async () => {
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", saveBody(), "https://other.example"), "willow")).status).toBe(403);
    expect((await savePricingResponse(request("/api/pricing/willow", "PUT", { note: "x".repeat(262145) }), "willow")).status).toBe(413);
    expect(mock.saveReview).not.toHaveBeenCalled();
  });

  it("returns actionable conflicts and redacts unexpected storage errors", async () => {
    mock.issueReview.mockRejectedValueOnce(new PricingStoreError("PRICING_CONFLICT", "This pricing review was changed elsewhere. Reload it before saving."));
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

describe("designer line changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.startLineChange.mockResolvedValue({ draft: { id: "draft-1", revision: 2 } });
  });
  const change = (actor: Actor, body: unknown = { itemId: "willow-desk" }) => {
    signIn(actor);
    return new NextRequest("http://localhost:3002/api/pricing/willow/change-line", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3002" },
    });
  };
  const jordan = designerActor(studio, { persona: "jordan" });

  it("lets the designer start a change and sends them to the pricing page; the client cannot", async () => {
    expect((await postLineChangeResponse(change(clientActor(studio, ["willow"])), "willow")).status).toBe(403);
    expect(mock.startLineChange).not.toHaveBeenCalled();
    const response = await postLineChangeResponse(change(jordan), "willow");
    expect(await response.json()).toEqual({ href: "/pricing/willow", draftId: "draft-1", revision: 2 });
    expect(mock.startLineChange.mock.calls[0][1]).toBe(studio);
    expect(mock.startLineChange.mock.calls[0][2]).toBe("willow");
    expect(mock.startLineChange.mock.calls[0][3]).toEqual({ itemId: "willow-desk" });
  });

  it("passes on what the supplier confirmed, and refuses malformed terms", async () => {
    const supplier = { reference: " QO-4471 ", quantity: 1, unitPriceCents: 12_999, taxCents: 1_137, freightCents: 0, leadTimeDays: null };
    expect((await postLineChangeResponse(change(jordan, { itemId: "willow-desk", supplier }), "willow")).status).toBe(200);
    expect(mock.startLineChange.mock.calls[0][3]).toEqual({ itemId: "willow-desk", supplier: { ...supplier, reference: "QO-4471" } });
    for (const bad of [{ ...supplier, reference: " " }, { ...supplier, quantity: 0 }, { ...supplier, taxCents: 1.5 }, { ...supplier, inStock: true }]) {
      expect((await postLineChangeResponse(change(jordan, { itemId: "willow-desk", supplier: bad }), "willow")).status).toBe(400);
    }
    expect(mock.startLineChange).toHaveBeenCalledTimes(1);
  });
});
