import { describe, expect, it } from "vitest";
import type { ProjectLedger } from "../approval/store";
import { HOME_APPROVED_QUOTE, HOME_ITEM_IDS } from "../demo/living-dining";
import { itemMappingKey } from "../pricing/document";
import { buildMoneyAnswer } from "./money-answer";
import { openingMoneyContext } from "./money-context";
import type { MoneyContext } from "./money-types";

const now = new Date("2026-10-29T21:00:00Z");
const businessId = (id: string) => `business-${id}`;
function operation(id: string, itemId: string | null, amountCents: number, patch: Partial<ProjectLedger["operations"][number]> = {}): ProjectLedger["operations"][number] {
  return { id, projectId: "project", kind: "authorize", status: "succeeded", businessKey: id, authorizationId: null, captureId: null, amountCents, currency: "USD", finalCapture: false, changeOrderId: null, revisionId: "v1-revision", contentHash: "hash", revisionContentHash: "hash", itemId, supplierEventId: null, savePaymentMethod: false, servicesHold: false, savedMethodId: null, replacesAuthorizationId: null, renewedAt: null, requestId: "PRIVATE-REQUEST", attempts: 1, paypalOrderId: `ORDER-${id}`, approvalUrl: "https://private-checkout.example/never-export", paypalResourceId: `AUTH-${id}`, failureCode: null, failureMessage: null, createdAt: now, updatedAt: now, ...patch };
}
function authorization(id: string, itemId: string | null, amountCents: number, patch: Partial<ProjectLedger["authorizations"][number]> = {}): ProjectLedger["authorizations"][number] {
  return { id, projectId: "project", itemId, paypalOrderId: `ORDER-${id}`, paypalAuthorizationId: `AUTH-${id}`, amountCents, currency: "USD", status: "created", honorExpiresAt: null, expiresAt: null, reauthorizedFromId: null, changeOrderId: null, operationId: `op-${id}`, createdAt: now, ...patch };
}
function fixture() {
  const quote = structuredClone(HOME_APPROVED_QUOTE);
  const itemMapping = Object.fromEntries(quote.lines.map((line) => [itemMappingKey({ ...line, sourceUrl: line.source.url ?? null }), businessId(line.itemId)]));
  const ledger: ProjectLedger = { authorizations: [], captures: [], refunds: [], operations: [], supplierEvents: [], servicesHoldLines: [], cancellations: [] };
  for (const itemId of HOME_ITEM_IDS) {
    const line = quote.lines.find((entry) => entry.itemId === itemId)!;
    const amount = line.quantity * line.unitPriceCents;
    ledger.authorizations.push(authorization(itemId, businessId(itemId), amount, { status: itemId === "sideboard" ? "captured" : "created" }));
    ledger.operations.push(operation(`op-${itemId}`, businessId(itemId), amount));
  }
  ledger.captures.push({ id: "capture-sideboard", projectId: "project", authorizationId: "sideboard", itemId: null, paypalCaptureId: "CAP-SIDEBOARD", amountCents: 120_000, currency: "USD", finalCapture: true, status: "completed", operationId: "capture-op", createdAt: now });
  ledger.operations.push(operation("capture-op", businessId("sideboard"), 120_000, { kind: "capture", authorizationId: "sideboard", finalCapture: true, paypalResourceId: "CAP-SIDEBOARD" }));
  return { key: "maple" as const, quote, itemMapping, ledger, now, providerRecordedAt: now.toISOString(), preparationStatus: "ready" as const };
}
const statement = (context: MoneyContext, id: string) => context.facts.find((fact) => fact.id === id)!.text.en;

describe("signed V1 payment evidence", () => {
  it("reads separate original holds, the completed sideboard capture and unpaid services without a change order", () => {
    const input = fixture(), before = structuredClone(input);
    const context = openingMoneyContext(input);
    expect(context).toMatchObject({ quoteId: input.quote.id, version: 1, providerRecordedAt: now.toISOString() });
    expect(statement(context, "item:baseline:sofa")).toContain("recorded held amount $2,400.00");
    expect(statement(context, "item:baseline:sideboard")).toContain("completed captures $1,200.00");
    expect(statement(context, "scope")).toMatch(/held \$5,530\.00, completed captures \$1,200\.00/);
    expect(statement(context, "next:baseline:design")).toContain("remaining $1,000.00 target");
    expect(statement(context, "next:baseline:sofa")).toContain("authorized, not charged");
    expect(context.sources).toContainEqual(expect.objectContaining({ kind: "payment", label: "PayPal V1 capture CAP-SIDEBOARD · completed", href: "/quotes/maple#item-holds" }));
    expect(context.sources.every((source) => !source.href.startsWith("/change-orders/"))).toBe(true);
    expect(context.facts.every((fact) => fact.sourceIds.every((id) => context.sources.some((source) => source.id === id)))).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE-REQUEST|private-checkout|signature|approvalUrl/);
    expect(input).toEqual(before);
  });

  it.each(["seeding", "failed"] as const)("preserves %s preparation as a mandatory warning before any payment exists", (preparationStatus) => {
    const input = fixture();
    input.ledger = { authorizations: [], captures: [], refunds: [], operations: [], supplierEvents: [], servicesHoldLines: [], cancellations: [] };
    const context = openingMoneyContext({ ...input, preparationStatus, providerRecordedAt: null });
    expect(context.mandatoryFactIds).toEqual(expect.arrayContaining(["payment-preparation", "no-provider-records"]));
    expect(statement(context, "payment-preparation")).toMatch(/do not treat absent amounts as zero or settled/);
    expect(statement(context, "next:baseline:sideboard")).toContain("not finished");
    const answer = buildMoneyAnswer(context, ["quote"]).moneyAnswer;
    expect(answer.facts.map((fact) => fact.id)).toEqual(expect.arrayContaining(["payment-preparation", "no-provider-records"]));
  });

  it("does not turn an accepted operation with a pending capture into completed money", () => {
    const input = fixture();
    input.ledger.captures[0].status = "pending";
    const context = openingMoneyContext(input);
    expect(statement(context, "item:baseline:sideboard")).toContain("completed captures $0.00");
    expect(statement(context, "next:baseline:sideboard")).toContain("pending or unknown");
    expect(context.mandatoryFactIds).toEqual(expect.arrayContaining(["next:baseline:sideboard", "funding-blockers"]));
  });

  it("allocates shared service holds by their recorded splits and keeps one source and warning per operation", () => {
    const input = fixture();
    input.quote.lines = input.quote.lines.slice(0, 2).map((line, index) => ({ ...line, itemId: `service-${index}`, category: "service" as const, quantity: 1, unitPriceCents: (index + 1) * 10_000 }));
    input.itemMapping = Object.fromEntries(input.quote.lines.map((line) => [itemMappingKey({ ...line, sourceUrl: line.source.url ?? null }), businessId(line.itemId)]));
    input.ledger = { authorizations: [authorization("shared", null, 30_000)], captures: [], refunds: [], supplierEvents: [], operations: [operation("op-shared", null, 30_000, { servicesHold: true, status: "unknown" })], servicesHoldLines: input.quote.lines.map((line) => ({ operationId: "op-shared", itemId: businessId(line.itemId), amountCents: line.unitPriceCents })), cancellations: [] };
    const context = openingMoneyContext(input);
    expect(statement(context, "item:baseline:service-0")).toContain("recorded held amount $100.00");
    expect(statement(context, "item:baseline:service-1")).toContain("recorded held amount $200.00");
    expect(statement(context, "scope")).toContain("held $300.00");
    expect(context.facts.filter((fact) => fact.id === "operation:op-shared")).toHaveLength(1);
    expect(context.sources.filter((source) => source.id === "hold:shared")).toHaveLength(1);
    expect(context.sources.find((source) => source.id === "hold:shared")?.href).toBe("/quotes/maple#design-services");
    expect(new Set(context.facts.map((fact) => fact.id)).size).toBe(context.facts.length);
  });
});
